"""Every intent the code can route must be an intent the prompt describes.

`show_verse` was in the enum, had a worker and a graph edge, and appeared in
router.md only inside prohibitions («NOT show_verse», "Do NOT use `show_verse`
for a range») — never once as a thing to choose. It survived because a
deterministic pre-classifier claims bare addresses before the model sees them;
the model was simply told a value existed and told never to pick it. Meanwhile
the same «БГ 2.13» was printed as a `research` example.

Nothing enforced the correspondence, so this does. It is cheap and it is the
only thing standing between "we added an intent" and "the model was never told".
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import pytest

import shruti_chat
from shruti_chat.domain.routing import Intent


_PROMPT = (
    Path(shruti_chat.__file__).resolve().parent / "agent" / "prompts" / "router.md"
)


def _bullets() -> dict[str, str]:
    """The `- <intent>: …` sections, by intent name."""
    text = _PROMPT.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    current: str | None = None
    for line in text.splitlines():
        m = re.match(r"^- ([a-z_\-]+): ", line)
        if m:
            current = m.group(1)
            out[current] = line
        elif current and line.startswith("  "):
            out[current] += "\n" + line
        elif current and not line.strip():
            continue
        else:
            current = None
    return out


@pytest.mark.parametrize("intent", sorted(get_args(Intent)))
def test_the_prompt_describes_every_routable_intent(intent: str) -> None:
    section = _bullets().get(intent)
    assert section is not None, (
        f"`{intent}` is routable but router.md never defines it — the model can "
        "only reach it by accident."
    )
    # A definition, not a mention: the section has to say something.
    assert len(section.splitlines()) >= 2


def test_the_prompt_invents_no_intent_the_router_cannot_return() -> None:
    unknown = set(_bullets()) - set(get_args(Intent))
    assert not unknown, f"router.md offers intents the enum rejects: {sorted(unknown)}"


@pytest.mark.parametrize("intent", sorted(get_args(Intent)))
def test_every_intent_has_at_least_one_example(intent: str) -> None:
    # The classifier is few-shot in practice; a section with no example is a
    # section the model has to guess at.
    assert "Examples" in _bullets()[intent], f"`{intent}` is described with no example"


def _examples(section: str) -> list[str]:
    """The quoted example queries in a section — what the model generalizes
    from. A sentence that merely NAMES another intent is guidance, not an
    example, and the two must not be confused."""
    return re.findall(r'"([^"]+)"', section)


def test_one_phrase_is_not_taught_as_two_intents() -> None:
    """«recommend me a lecture» was an example under `recommend` while the
    `help` section said the same words route to `find_track` — one phrase,
    two destinations, four lines apart."""
    owners = {
        k: _examples(v) for k, v in _bullets().items()
    }
    seen: dict[str, str] = {}
    clashes: list[str] = []
    for intent, examples in owners.items():
        for ex in examples:
            if ex in seen and seen[ex] != intent:
                clashes.append(f"{ex!r}: {seen[ex]} vs {intent}")
            seen[ex] = intent
    assert not clashes, clashes


def test_the_prompt_covers_asking_the_app_to_do_something() -> None:
    """Two real requests fell through the cracks on 2026-08-06.

    «Browse by author» became a lecture search with nothing to search for —
    it timed out and the person got an empty bubble. «1st one start it», right
    after a list of cards, produced five DIFFERENT lectures instead of playing
    the one they pointed at.

    Neither is something the assistant can do — it cannot open a screen or
    press play — and both are documented in the help pages, so `help` is the
    only honest destination. The line that keeps this from swallowing real
    requests is the one about naming: «включи что-нибудь» still wants a
    lecture chosen, and that is `recommend`."""
    section = _bullets()["help"]
    assert "browse by author" in section.lower()
    assert "start it" in section.lower()
    # …and the guard against over-reach.
    assert "recommend" in section, "asking WHICH lecture to play is not app help"


def test_facet_browsing_is_not_taught_as_a_lecture_search() -> None:
    """The tell has to be written down, or the next reader re-litigates it:
    naming what to look for is a search, naming a facet is navigation."""
    section = _bullets()["help"]
    assert "NAMES what to look for is find_track" in section


def test_a_pointer_at_the_previous_list_outranks_the_topic_in_it() -> None:
    """«включи первую» after a list of five was answered with five DIFFERENT
    lectures. The follow-up rewriter had done its job — it expanded the message
    to «включи первую лекцию про смирение» — and the topic it added then won
    over the pointer, so the search replaced the very list being pointed at."""
    section = _bullets()["help"]
    assert "POINTER" in section
    assert "WINS over any topic" in section
