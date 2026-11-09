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
    """Works with anything that speaks the OpenAI chat-completions API.

    Hosted OpenAI:  LLM_BASE_URL=https://api.openai.com/v1   LLM_API_KEY=sk-...
    Local Ollama:   LLM_BASE_URL=http://localhost:11434/v1   LLM_API_KEY=ollama (any text)
    """

    def __init__(self):
        self.base_url = os.getenv("LLM_BASE_URL", "http://localhost:11434/v1").rstrip("/")
        self.model = os.environ["LLM_MODEL"]
        self.api_key = os.getenv("LLM_API_KEY", "none")
        self.client = httpx.Client(timeout=60)

    def translate(self, text, source, target):
        start = time.perf_counter()

        src = LANGUAGE_NAMES.get(source, source)
        tgt = LANGUAGE_NAMES.get(target, target)

        system = (
            f"Translate this gaming voice chat from {src} to {tgt}. "
            "Preserve gaming slang, names, tone and context. "
            "Be concise and natural. "
            "Return only the translation."
        )

        prompt_time = time.perf_counter()

        resp = self.client.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "temperature": 0,
                "max_tokens": 256,
                "stream": False,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": text},
                ],
            },
        )

        response_time = time.perf_counter()
        resp.raise_for_status()

        out = resp.json()["choices"][0]["message"]["content"]
        out = re.sub(r"<think>.*?</think>", "", out, flags=re.DOTALL).strip()

        end = time.perf_counter()

        print(
            f"[TRANSLATION] {source}->{target} | "
            f"HTTP: {response_time - prompt_time:.3f}s | "
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