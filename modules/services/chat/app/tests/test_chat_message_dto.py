"""Role-aware content cap on ChatMessageDto.

The 4000-char cap bounds a user *question*. It must NOT reject assistant
turns: the client replays the server's own prior (long) replies as history
on every subsequent turn, so capping them at 4000 breaks multi-turn chat.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from lectorium_chat.api.schemas.chat import (
    ASSISTANT_CONTENT_MAX,
    HISTORY_HARD_MAX,
    HISTORY_WINDOW,
    USER_CONTENT_MAX,
    ChatMessageDto,
    ChatRequestDto,
)


def _history(n: int) -> list[dict[str, str]]:
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"}
        for i in range(n)
    ]


def test_user_message_within_cap_ok():
    msg = ChatMessageDto(role="user", content="x" * USER_CONTENT_MAX)
    assert len(msg.content) == USER_CONTENT_MAX


def test_user_message_over_cap_rejected():
    with pytest.raises(ValidationError):
        ChatMessageDto(role="user", content="x" * (USER_CONTENT_MAX + 1))


def test_long_assistant_message_accepted():
    # A real assistant answer with prose + citations easily exceeds the
    # user cap; replaying it in history must not 422.
    content = "y" * (USER_CONTENT_MAX * 3)
    msg = ChatMessageDto(role="assistant", content=content)
    assert len(msg.content) == USER_CONTENT_MAX * 3


def test_assistant_message_over_hard_ceiling_rejected():
    with pytest.raises(ValidationError):
        ChatMessageDto(
            role="assistant", content="y" * (ASSISTANT_CONTENT_MAX + 1)
        )


def test_over_long_history_is_trimmed_not_rejected():
    # #1771: this used to 422, which made a conversation permanently
    # unsendable from its 21st message on.
    req = ChatRequestDto(messages=_history(HISTORY_WINDOW + 5))
    assert len(req.messages) == HISTORY_WINDOW
    # Newest kept — the last message is the question being asked.
    assert req.messages[-1].content == f"m{HISTORY_WINDOW + 4}"
    assert req.messages[0].content == "m5"


def test_history_within_window_untouched():
    req = ChatRequestDto(messages=_history(HISTORY_WINDOW))
    assert len(req.messages) == HISTORY_WINDOW
    assert req.messages[0].content == "m0"


def test_history_past_abuse_ceiling_rejected():
    with pytest.raises(ValidationError):
        ChatRequestDto(messages=_history(HISTORY_HARD_MAX + 1))
