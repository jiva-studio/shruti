"""AuthorSelection — which lecturers an answer may draw on.

Read off the `lecture_authors` conversation attribute (see
`conversation_attributes`), so it is set the same two ways anything else about a
dialogue is: the person picks lecturers in the app, or asks for them in words —
and either way it holds for the rest of the conversation until they change it.

Three states, and the DEFAULT IS NO CONSTRAINT. A filter exists only because
someone asked for one; nothing is narrowed on their behalf. `ALL` is the
explicit form of the same thing, and it is how a filter is LIFTED — the merge
has no way to remove an attribute, so «ищи у всех» has to be a value rather
than an absence.

What it constrains is LECTURES only. Books are canon: verses, chapters,
letters, and the purports are never filtered by who is speaking, so an answer
narrowed to one teacher still quotes scripture and its commentary.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from shruti_chat.domain.conversation_attributes import (
    ALL,
    LECTURE_AUTHORS,
    Attribute,
)


@dataclass(frozen=True)
class AuthorSelection:
    """The lecturers in force for a turn.

    `ids` are catalog author ids; `names` are what to call them when the answer
    has to admit it found nothing by them. Both empty with `constrained=False`
    means "everyone", which is the default.
    """

    ids: tuple[str, ...] = ()
    names: str = ""
    constrained: bool = False
    # True when the person stated it — picked it in the app or asked in words —
    # as opposed to it being inferred. Only an explicit selection reaches their
    # OWN added lectures: a default must never hide someone's own library.
    explicit: bool = False

    @classmethod
    def unconstrained(cls) -> "AuthorSelection":
        return cls()

    @classmethod
    def from_attributes(
        cls, attributes: Mapping[str, Attribute],
    ) -> "AuthorSelection":
        """Read the selection out of a settled attribute map.

        Absent, unsettled, or containing `ALL` ⇒ unconstrained. `ALL` wins over
        anything listed beside it: "everyone plus these two" is still everyone,
        and treating the pair as a narrowing would silently drop the wider half.
        """
        attr = attributes.get(LECTURE_AUTHORS)
        if attr is None or not attr.settled() or ALL in attr.value:
            return cls.unconstrained()
        return cls(
            ids=tuple(attr.value),
            names=attr.label,
            constrained=True,
            explicit=attr.explicit,
        )

    def allows(self, author_id: str | None) -> bool:
        """Whether a lecture by this author may be used.

        An unknown author is NOT allowed under a constraint: a lecture we cannot
        attribute is not known to be by the person who was asked for. It rides
        through freely when nothing is constrained, which is the default.
        """
        if not self.constrained:
            return True
        return bool(author_id) and author_id in self.ids
