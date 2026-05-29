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
    USER_CONTENT_MAX,
    ChatMessageDto,
)


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
