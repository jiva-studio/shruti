"""ReplyLanguage — the language the assistant answers in, and how we know it.

The client's `lang` is only the app's UI locale; almost nobody changes it, so
it is a weak hint about what the person actually reads. What settles the reply
language is the conversation itself, in this precedence:

1. the user NAMED a language for the reply («отвечай по-русски») — that stands
   for the rest of the dialogue, so it outranks the language of any later
   message (an English quote pasted into a Russian conversation must not flip
   the reply back to English)
2. otherwise the language the current message is written in
3. otherwise whatever we settled on earlier in this dialogue
4. otherwise nothing is derived and the caller keeps the client's locale

`requested` is what separates rule 1 from rule 2, and it is the only reason
this is a value object rather than a bare string: a stored locale alone cannot
say whether it may be overridden by the next message's own language.

Pydantic (not a dataclass) because the same shape is the structured output of
the detector LLM call AND the payload persisted on the assistant message.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator


class ReplyLanguage(BaseModel):
    """A settled answer language. `lang` empty = nothing settled (the
    detector abstained), which is a normal outcome on «БГ 2.13» or «ok»."""

    model_config = ConfigDict(extra="ignore")

    # Locale code as the model wrote it ("ru", "it", "sr-Latn"). Deliberately
    # NOT validated against a list of shipped locales: the reply language is an
    # open set — «Cos'è il karma?» must be answered in Italian even though the
    # app ships no Italian UI.
    lang: str = ""
    # Native name of that language ("Русский", "Italiano"). Carried because the
    # prompts interpolate `{{LANG_NAME}}`, and a bare code makes the model drift
    # to Russian (see `_language_name_sync`). For a locale the catalog knows,
    # the catalog's name wins; this covers the ones it doesn't.
    name: str = ""
    # True only when the user asked for this language in words.
    requested: bool = False

    @field_validator("lang", "name", mode="before")
    @classmethod
    def _trimmed(cls, value: Any) -> Any:
        # `lang` becomes the retrieval + directive locale, so a stray " ru"
        # would miss every per-locale catalog lookup.
        return value.strip() if isinstance(value, str) else value

    def settled(self) -> bool:
        return bool(self.lang)


def resolve_reply_language(
    *,
    detected: ReplyLanguage | None,
    remembered: ReplyLanguage | None,
) -> ReplyLanguage | None:
    """Apply the precedence above. Returns None when nothing was derived —
    the caller then keeps the locale the client sent and stores nothing, so a
    later change of the app's language is not shadowed by a value we invented.
    """
    candidates = [c for c in (detected, remembered) if c is not None and c.settled()]
    asked_for = [c for c in candidates if c.requested]
    if asked_for:
        return asked_for[0]
    return candidates[0] if candidates else None
