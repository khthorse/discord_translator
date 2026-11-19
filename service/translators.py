"""Swappable translation backends.

Every backend has the same shape: translate(text, source_lang, target_lang) -> str | None.
Pick one with TRANSLATOR in .env:

    none    -> no translation, transcription only (good for the first test)
    google  -> Google Cloud Translation API (needs GOOGLE_API_KEY)
    openai  -> any OpenAI-compatible chat endpoint: OpenAI, Ollama, llama.cpp, LM Studio...
"""

import os
import re
import time

import httpx

# Language codes (the ones Whisper uses) -> names for the LLM prompt. An unknown code is sent
# as-is, which most LLMs understand, so a missing entry is not fatal.
LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "no": "Norwegian",
    "nn": "Norwegian (Nynorsk)",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "de": "German",
    "fr": "French",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "ru": "Russian",
    "uk": "Ukrainian",
    "tr": "Turkish",
    "ar": "Arabic",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
}


class Translator:
    def translate(self, text: str, source: str, target: str) -> str | None:
        raise NotImplementedError


class NoTranslator(Translator):
    def translate(self, text, source, target):
        return None


class GoogleTranslator(Translator):
    """Google Cloud Translation API (v2, 'Basic'). Create an API key in Google Cloud Console."""

    URL = "https://translation.googleapis.com/language/translate/v2"

    def __init__(self):
        self.key = os.environ["GOOGLE_API_KEY"]
        self.client = httpx.Client(timeout=15)

    def translate(self, text, source, target):
        resp = self.client.post(
            self.URL,
            params={"key": self.key},
            json={"q": text, "source": source, "target": target, "format": "text"},
        )
        resp.raise_for_status()
        return resp.json()["data"]["translations"][0]["translatedText"]




class OpenAICompatTranslator(Translator):
    """Uses Ollama's native chat API for faster local translation."""

    def __init__(self):
        self.base_url = os.getenv(
            "LLM_BASE_URL", "http://localhost:11434"
        ).rstrip("/")
        self.model = os.environ["LLM_MODEL"]
        self.client = httpx.Client(timeout=60)


    def translate(self, text, source, target):
        start = time.perf_counter()

        src = LANGUAGE_NAMES.get(source, source)
        tgt = LANGUAGE_NAMES.get(target, target)

        prompt = (
            f"You are a professional {src} ({source}) to "
            f"{tgt} ({target}) translator. "
            f"Your goal is to accurately convey the meaning and "
            f"nuances of the original {src} text while adhering "
            f"to {tgt} grammar, vocabulary, and cultural sensitivities. "
            f"Produce only the {tgt} translation, without any "
            f"additional explanations or commentary. "
            f"Please translate the following {src} text into {tgt}:\n\n\n"
            f"{text}"
        )

        request_start = time.perf_counter()

        resp = self.client.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "stream": False,
                "keep_alive": "2h",
                "options": {
                    "temperature": 0,
                    "num_predict": 256,
                },
            },
        )

        request_end = time.perf_counter()
        print(
            f"[HTTP DEBUG] Request: "
            f"{request_end - request_start:.3f}s"
        )

        response_time = time.perf_counter()
        resp.raise_for_status()

        parse_start = time.perf_counter()
        data = resp.json()
        parse_end = time.perf_counter()

        print(
            f"[HTTP DEBUG] JSON parsing: "
            f"{parse_end - parse_start:.3f}s"
        )

        print(
            f"[OLLAMA] Total: {data.get('total_duration', 0) / 1e9:.3f}s | "
            f"Load: {data.get('load_duration', 0) / 1e9:.3f}s | "
            f"Prompt: {data.get('prompt_eval_duration', 0) / 1e9:.3f}s | "
            f"Generation: {data.get('eval_duration', 0) / 1e9:.3f}s"
        )

        out = data["message"]["content"]

        out = re.sub(
            r"<think>.*?</think>", "", out, flags=re.DOTALL
        ).strip()

        end = time.perf_counter()

        print(
            f"[TRANSLATION] {source}->{target} | "
            f"HTTP: {response_time - start:.3f}s | "
            f"Total: {end - start:.3f}s"
        )

        return out




def build_translator(name: str) -> Translator:
    name = name.lower()
    if name == "none":
        return NoTranslator()
    if name == "google":
        return GoogleTranslator()
    if name == "openai":
        return OpenAICompatTranslator()
    raise ValueError(f"Unknown TRANSLATOR '{name}'. Use none, google or openai.")