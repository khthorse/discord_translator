
"""Audio in, text out. Receives a WAV from the Discord bot, transcribes it with faster-whisper,
translates it, and returns JSON. Run with: python main.py
"""

import io
import math
import os
import sysconfig
import threading
import time
import wave
from pathlib import Path

# ---------------------------------------------------------------- CUDA setup ---

# Make NVIDIA CUDA DLLs available to CTranslate2 on Windows.
# Keep directory handles alive for the lifetime of the application.

_cuda_dll_handles = []

if os.name == "nt":
    _nvidia_dir = Path(sysconfig.get_paths()["purelib"]) / "nvidia"

    if _nvidia_dir.exists():
        _cuda_dll_dirs = [
            str(folder)
            for folder in _nvidia_dir.glob("*/bin")
            if folder.is_dir()
        ]

        # Add NVIDIA DLL folders to PATH.
        os.environ["PATH"] = (
            os.pathsep.join(_cuda_dll_dirs)
            + os.pathsep
            + os.environ.get("PATH", "")
        )

        # Register DLL directories with Windows.
        for folder in _cuda_dll_dirs:
            _cuda_dll_handles.append(os.add_dll_directory(folder))

# ---------------------------------------------------------------- imports ---

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from faster_whisper import WhisperModel
from scipy.signal import resample_poly

from translators import build_translator

# ---------------------------------------------------------------- config ---

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "float16")
HOST = os.getenv("SERVICE_HOST", "127.0.0.1")
PORT = int(os.getenv("SERVICE_PORT", "8000"))

print(
    f"Loading Whisper model '{WHISPER_MODEL}' "
    f"on {WHISPER_DEVICE} ({WHISPER_COMPUTE})..."
)

model = WhisperModel(
    WHISPER_MODEL,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE,
)

translator = build_translator(os.getenv("TRANSLATOR", "none"))
print(f"Translator: {type(translator).__name__}")

# Keep a small, configurable number of Whisper jobs active at once.
# CTranslate2 supports concurrent calls; start conservatively to avoid GPU contention.
MAX_CONCURRENT_TRANSCRIPTIONS = max(
    1, int(os.getenv("MAX_CONCURRENT_TRANSCRIPTIONS", "2"))
)
transcription_slots = threading.BoundedSemaphore(MAX_CONCURRENT_TRANSCRIPTIONS)

app = FastAPI()


def wav_to_whisper_audio(wav_bytes: bytes) -> np.ndarray:
    """Convert 16-bit PCM WAV audio to 16 kHz mono float32 audio."""

    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())

    if width != 2:
        raise ValueError("expected 16-bit PCM")

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if rate != 16000:
        g = math.gcd(16000, rate)
        samples = resample_poly(
            samples,
            16000 // g,
            rate // g,
        )

    return np.ascontiguousarray(samples, dtype=np.float32)


def split_codes(value: str) -> list[str]:
    """Convert 'es, en,,es' into ['es', 'en']."""

    seen: list[str] = []

    for part in value.split(","):
        code = part.strip().lower()

        if code and code not in seen:
            seen.append(code)

    return seen


def pick_language(audio, candidates: list[str]) -> str | None:
    """Determine the spoken language from the configured candidates."""

    if len(candidates) == 1:
        return candidates[0]

    try:
        _, _, probs = model.detect_language(audio)
        p = dict(probs)

    except Exception as err:
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
        raise HTTPException(
            status_code=400,
            detail=f"bad audio: {err}",
        )

    queue_started = time.perf_counter()
    transcription_slots.acquire()
    queue_wait = time.perf_counter() - queue_started

    try:
        stt_started = time.perf_counter()
        lang = pick_language(audio, candidates)

        segments, info = model.transcribe(
            audio,
            language=lang,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )

        # Segments are generated lazily, so processing happens during iteration.
        text = " ".join(
            s.text.strip()
            for s in segments
            if s.no_speech_prob < 0.7
        ).strip()

        lang = lang or info.language
        stt_duration = time.perf_counter() - stt_started
    finally:
        transcription_slots.release()

    t1 = time.perf_counter()

    # Translate only when this speaker's settings allow it.
    translations: dict[str, str] = {}

    allowed = (
        translate_enabled
        and (not translate_from or lang == translate_from)
    )

    if text and lang and allowed:
        for target in targets:
            if target == lang:
                continue

            try:
                translations[target] = translator.translate(
                    text,
                    lang,
                    target,
                )

            except Exception as err:
                print(
                    f"Translation {lang}->{target} failed: {err}"
                )

    t2 = time.perf_counter()

    print(
        f"[{speaker}] ({lang}) {text!r} -> {translations or None}  "
        f"[queue {queue_wait:.2f}s, stt {stt_duration:.2f}s, "
        f"translate {t2 - t1:.2f}s, total {t2 - t0:.2f}s]"
    )

    return {
        "language": lang,
        "original": text,
        "translations": translations,
    }


@app.post("/process")
async def process_endpoint(
    request: Request,
    speaker: str = "unknown",
    candidates: str = "",
    targets: str = "",
    translate_from: str = "",
    translate: bool = True,
):
    body = await request.body()

    if len(body) < 1000:
        raise HTTPException(
            status_code=400,
            detail="audio too short",
        )

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
    return {
        "ok": True,
        "model": WHISPER_MODEL,
        "translator": type(translator).__name__,
        "max_concurrent_transcriptions": MAX_CONCURRENT_TRANSCRIPTIONS,
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
