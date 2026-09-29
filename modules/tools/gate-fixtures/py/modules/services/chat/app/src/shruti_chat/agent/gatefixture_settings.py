"""Known violation: the agent runtime reads settings instead of TurnContext.settings."""

from shruti_chat.config import get_settings as fixture  # noqa: F401
