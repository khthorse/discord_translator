"""Small, deterministic helpers for selecting an allowed Whisper language."""


def resolve_allowed_languages(
    server_languages: list[str],
    user_languages: list[str],
) -> list[str]:
    """Apply the server allowlist, then let a user preference narrow it.

    An empty server list means the server has not configured a restriction.
    User preferences can narrow that unrestricted set, but cannot expand a
    non-empty server allowlist.
    """
    if server_languages:
        if user_languages:
            return [code for code in server_languages if code in user_languages]
        return list(server_languages)
    return list(user_languages)


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
