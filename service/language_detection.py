"""Small, deterministic helpers for selecting a Whisper language hint."""


def requested_language_hint(allowed_languages: list[str], language_hint: str) -> str | None:
    """Reuse a valid turn hint, or force the sole allowed language."""
    if language_hint in allowed_languages:
        return language_hint
    if len(allowed_languages) == 1:
        return allowed_languages[0]
    return None


def best_allowed_language(allowed_languages: list[str], probabilities: dict[str, float]) -> str | None:
    """Choose the most probable allowed language, preserving list order on ties."""
    if not allowed_languages:
        return None
    return max(allowed_languages, key=lambda code: probabilities.get(code, 0.0))
