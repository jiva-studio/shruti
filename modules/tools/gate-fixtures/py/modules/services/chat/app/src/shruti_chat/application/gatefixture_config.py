"""Known violation: a use case reads settings instead of receiving them."""

from shruti_chat.config import get_settings as fixture  # noqa: F401
