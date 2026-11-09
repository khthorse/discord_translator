"""Audio in, text out. Receives a WAV from the Discord bot, transcribes it with faster-whisper,
translates it (Spanish <-> English), and returns JSON. Run with:  python main.py
"""

import io
import os
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _add_nvidia_dll_dirs() -> None:
    """Windows: if cuBLAS/cuDNN were installed with pip (nvidia-* packages), make their DLLs findable."""
    if os.name != "nt":
        return
    try:
        import nvidia  # namespace package created by the nvidia-*-cu12 wheels
    except ImportError:
        return
    for base in nvidia.__path__:
        for bin_dir in Path(base).glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()

import math  # noqa: E402
import wave  # noqa: E402

import numpy as np  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

from translators import build_translator  # noqa: E402

# ---------------------------------------------------------------- config ---
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")  # "cuda" or "cpu"
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "float16")  # "float16" on GPU, "int8" on CPU
HOST = os.getenv("SERVICE_HOST", "127.0.0.1")  # keep local: this endpoint has no authentication
PORT = int(os.getenv("SERVICE_PORT", "8000"))

print(f"Loading Whisper model '{WHISPER_MODEL}' on {WHISPER_DEVICE} ({WHISPER_COMPUTE})...")
model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
translator = build_translator(os.getenv("TRANSLATOR", "none"))
print(f"Translator: {type(translator).__name__}")

# One GPU job at a time. Requests queue up behind this lock.
gpu_lock = threading.Lock()

app = FastAPI()


def wav_to_whisper_audio(wav_bytes: bytes) -> np.ndarray:
    """Turn the bot's WAV (16-bit PCM, 48 kHz stereo) into what Whisper wants:
    16 kHz, mono, float32 values between -1 and 1.

    We read the WAV ourselves instead of using faster-whisper's decode_audio, because that
    helper depends on PyAV and breaks with some PyAV versions. The format is under our control.
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
        raw = wav.readframes(wav.getnframes())
    if width != 2:
        raise ValueError("expected 16-bit PCM")

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)  # stereo -> mono
    if rate != 16000:
        g = math.gcd(16000, rate)
        samples = resample_poly(samples, 16000 // g, rate // g)  # 48 kHz -> 16 kHz (low-pass included)
    return np.ascontiguousarray(samples, dtype=np.float32)


def split_codes(value: str) -> list[str]:
    """'es, en,,es' -> ['es', 'en'] (trimmed, lowercase, no empties, no duplicates, in order)."""
    seen: list[str] = []
    for part in value.split(","):
        code = part.strip().lower()
        if code and code not in seen:
            seen.append(code)
    return seen


def pick_language(audio, candidates: list[str]) -> str | None:
    """Decide which language this clip is in.

    The bot tells us which languages are possible (the server's rooms plus the speaker's own
    language). Choosing only among those avoids the random mislabels Whisper makes on short
    clips (French, Swedish...) and, with a single candidate, skips detection entirely.
    With no candidates we take Whisper's top guess. Forcing a wrong language is worse than
    guessing, since Whisper then outputs a translation instead of a transcript.
    """
    if len(candidates) == 1:
        return candidates[0]
    try:
        _, _, probs = model.detect_language(audio)
        p = dict(probs)
    except Exception as err:  # fall back to Whisper's own detection
        print(f"Language detection failed, using auto-detect: {err}")
        return None

    pool = candidates or list(p)
    return max(pool, key=lambda code: p.get(code, 0.0))


def process(
    wav_bytes: bytes,
    speaker: str,
    candidates: list[str],
    targets: list[str],
    translate_from: str,
    translate_enabled: bool,
) -> dict:
    t0 = time.perf_counter()

    try:
        audio = wav_to_whisper_audio(wav_bytes)
    except (wave.Error, ValueError, EOFError) as err:
        raise HTTPException(status_code=400, detail=f"bad audio: {err}")

    with gpu_lock:
        lang = pick_language(audio, candidates)
        segments, info = model.transcribe(
            audio,
            language=lang,
            beam_size=5,
            vad_filter=True,  # Whisper's built-in voice detection trims silence and cuts hallucinations
            condition_on_previous_text=False,
        )
        # `segments` is a lazy generator: the actual work happens while we loop over it.
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.7).strip()
        lang = lang or info.language

    t1 = time.perf_counter()

    # Translate only when this speaker's settings allow it. `translate_from` is the language the
    # speaker has set: speech in any other language (a Spanish speaker's occasional English)
    # is left alone. Empty means "any language".
    translations: dict[str, str] = {}
    allowed = translate_enabled and (not translate_from or lang == translate_from)
    if text and lang and allowed:
        for target in targets:
            if target == lang:
                continue
            try:
                translations[target] = translator.translate(text, lang, target)
            except Exception as err:
                print(f"Translation {lang}->{target} failed: {err}")  # keep the other targets

    t2 = time.perf_counter()
    print(
        f"[{speaker}] ({lang}) {text!r} -> {translations or None}  "
        f"[stt {t1 - t0:.2f}s, translate {t2 - t1:.2f}s]"
    )
    return {"language": lang, "original": text, "translations": translations}


@app.post("/process")
async def process_endpoint(
    request: Request,
    speaker: str = "unknown",
    candidates: str = "",  # possible spoken languages, e.g. "es,en"
    targets: str = "",  # languages to translate into, e.g. "en,es"
    translate_from: str = "",  # only translate speech in this language ("" = any)
    translate: bool = True,  # false = never translate this speaker
):
    body = await request.body()
    if len(body) < 1000:
        raise HTTPException(status_code=400, detail="audio too short")
    # Whisper blocks, so run it in a worker thread and keep the web server responsive.
    return await run_in_threadpool(
        process,
        body,
        speaker,
        split_codes(candidates),
        split_codes(targets),
        translate_from.strip().lower(),
        translate,
    )


@app.get("/health")
def health():
    return {"ok": True, "model": WHISPER_MODEL, "translator": type(translator).__name__}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)