"""Conversation attributes — what we worked out about a dialogue, keyed.

Distinct from the router's `extracted_args`, and the difference is LIFETIME.
`extracted_args` describes THIS request (a source, a chapter, an author, a
year); it feeds the filters and dies with the turn. An attribute describes the
CONVERSATION and outlives the turn: it rides out on the terminal `done`, the
client stores it on the assistant message and replays it, so it survives both
the 20-message history cap and an app restart.

Today: the reply language, and the lecturers an answer may be built from. They
are entries in a map rather than fields of their own so the next one — whatever
we learn to read out of a dialogue — costs no protocol change, no client release
and no migration: an unknown key rides through every layer untouched.

Each entry carries:
  `value`    the machine value, an opaque string (locale code, an id, a flag)
  `label`    its human form, when the value alone can't be shown or prompted
             with — for the language that is the native name, because a bare
             code in `{{LANG_NAME}}` makes models drift to Russian
  `explicit` the user SAID it, we did not infer it. This is what makes it
             outrank a fresh inference: after «отвечай по-русски», an English
             quote pasted into the conversation must not flip the reply back.

The precedence in `merge_attributes` is the same for every key on purpose —
per-attribute merge rules would be a second thing to reason about for no
demonstrated need. What each attribute MEANS is decided where it is consumed,
not here: the language becomes `ctx.lang_code`, and the next attribute will go
somewhere else entirely.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, field_serializer, field_validator


# The reply language: which language this turn's answer is written in. Its
# value is a locale code and is NOT constrained to the languages the app ships
# — «Cos'è il karma?» is answered in Italian with no Italian UI. Single-valued.
REPLY_LANGUAGE = "reply_language"

# Which lecturers the answer may draw on. Multi-valued (a person can pick
# several), and `ALL` is how a filter is LIFTED — see `AuthorSelection`.
LECTURE_AUTHORS = "lecture_authors"

# "no constraint", as an explicit value. An attribute that is simply absent
# means the same thing; this exists so someone who narrowed the search can say
# «ищи у всех» and have that stick, which removal cannot express (there is no
# tombstone in the merge).
ALL = "*"


class Attribute(BaseModel):
    """One settled attribute.

    `value` is ISOMORPHIC on the wire: a single-valued attribute reads and
    writes as a bare string (`"ru"`), a multi-valued one as an array
    (`["author_a", "author_b"]`). Internally it is always a list, so nothing
    downstream branches on the shape — the coercion happens once, here.
    Unsettled = empty, which is a normal outcome (on «БГ 2.13» there is no
    language to read).

    `label` describes the WHOLE selection, not one element — «Русский»,
    «Прабхупада и Бхактивинода» — because that is what a UI chip and an honest
    "nothing by them" line need.

    NOT the schema an LLM fills. Each attribute's detector has its own
    structured-output model (the language one names a locale, the author one
    names PEOPLE the server then resolves to ids), so no model is ever asked to
    produce a union.
    """

    model_config = ConfigDict(extra="ignore")

    value: list[str] = []
    label: str = ""
    explicit: bool = False

    @field_validator("value", mode="before")
    @classmethod
    def _as_clean_list(cls, value: Any) -> Any:
        # Trim, drop blanks, de-duplicate but keep order: a padded locale code
        # would miss every per-locale catalog lookup, and a repeated author id
        # would widen nothing while making the label wrong.
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return value
        out: list[str] = []
        for v in value:
            if not isinstance(v, str):
                continue
            v = v.strip()
            if v and v not in out:
                out.append(v)
        return out

    @field_validator("label", mode="before")
    @classmethod
    def _trimmed(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_serializer("value")
    def _shortest_shape(self, value: list[str]) -> str | list[str]:
        # A single value goes back out as the bare string it came in as, so a
        # round trip is shape-stable and a reader of the stored JSON is not
        # asked why a language is an array of one.
        return value[0] if len(value) == 1 else value

    def settled(self) -> bool:
        return bool(self.value)

    def single(self) -> str:
        """The one value of a single-valued attribute, or "" when unsettled."""
        return self.value[0] if self.value else ""


def merge_attributes(
    *,
    detected: Mapping[str, Attribute],
    remembered: Mapping[str, Attribute],
) -> dict[str, Attribute]:
    """Fold this turn's readings into what the dialogue already knew.

    Per key: something the user stated wins over anything inferred, a fresh
    reading wins over a stale one of equal standing, and a key nobody read this
    turn simply carries forward. Keys are independent — a turn that settles one
    attribute never disturbs another.

    Unsettled entries are dropped, so the result only ever contains attributes
    worth remembering: nothing is stored that we did not actually derive, and a
    later change of app settings is not shadowed by a value we invented.
    """
    out: dict[str, Attribute] = {
        key: attr for key, attr in remembered.items() if attr.settled()
    }
    for key, fresh in detected.items():
        if not fresh.settled():
            continue
        previous = out.get(key)
        if previous is not None and previous.explicit and not fresh.explicit:
            continue
        out[key] = fresh
    return out
