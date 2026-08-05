"""The assistant must call the app what the app calls itself.

Asked in German what it can do, the chat answered «Ich bin dein KI-Assistent für
die „Sende zu Sadhu"-App» — a product that does not exist. The prompt named the
app once, in English with a Russian gloss, and said nothing about whether that
name may be translated; the model filled the gap.

The app ships its own name in fourteen locales, and that file is the source of
truth. This test reads it and requires every localized form to appear in the
prompt — so renaming the app in the client cannot silently leave the assistant
introducing itself as something else.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import lectorium_chat


_PROMPT = (
    Path(lectorium_chat.__file__).resolve().parent / "agent" / "prompts" / "header.md"
)
_I18N = (
    Path(__file__).resolve().parents[4] / "apps" / "mobile" / "lectorium" / "i18n"
    / "locales"
)

_ENGLISH = "Shruti"


def _names() -> dict[str, str]:
    """`{locale: app name}` straight from the client's own strings."""
    out: dict[str, str] = {}
    for app_ts in sorted(_I18N.glob("*/app.ts")):
        m = re.search(r'^\s*name:\s*"([^"]+)"', app_ts.read_text(encoding="utf-8"), re.M)
        if m:
            out[app_ts.parent.name] = m.group(1)
    return out


pytestmark = pytest.mark.skipif(
    not _I18N.is_dir(), reason=f"client i18n not present at {_I18N}"
)


def test_the_client_strings_are_where_we_think_they_are() -> None:
    # Without this, a moved path would turn every check below into a silent pass.
    names = _names()
    assert len(names) >= 10, names
    assert names.get("en") == _ENGLISH


@pytest.mark.parametrize("locale", sorted(_names()))
def test_every_localized_name_is_in_the_prompt(locale: str) -> None:
    name = _names()[locale]
    text = _PROMPT.read_text(encoding="utf-8")
    assert name in text, (
        f"the app is called {name!r} in {locale}, and the prompt never says so — "
        "the model will invent a translation, as it did in German."
    )


def test_the_prompt_forbids_inventing_a_translation() -> None:
    text = _PROMPT.read_text(encoding="utf-8").lower()
    # The rule, not just the names: a bare list would still let the model
    # translate the English form for a locale that has no listed variant.
    assert "not a phrase to translate" in text
    assert "never invent a translation" in text


def test_locales_with_no_variant_of_their_own_keep_the_english_name() -> None:
    """Ten of the fourteen use the English name verbatim; the prompt has to say
    that explicitly, because "stays as-is" is exactly what a model guesses at."""
    plain = [loc for loc, name in _names().items() if name == _ENGLISH]
    assert len(plain) >= 8, plain
    text = _PROMPT.read_text(encoding="utf-8")
    assert "stays Shruti in every other language" in text
