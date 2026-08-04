"""Settings that ignore the environment, for the rate-limit unit tests.

Those tests assert the SHIPPED caps ("anonymous gets 3 chats a day", "one IP is
bounded at 2000"), so they must read the model's own defaults and nothing else.
`Settings(_env_file=None, …)` was written for that and is not enough: it disables
the dotenv *file* source, but `litellm` calls `load_dotenv()` when it is imported,
which copies the local dev `.env` into `os.environ` — and env vars still win over
a model default. The dev file lowers `IP_RATE_LIMIT_PER_DAY` to 200 (a value
`.env.example` itself marks as retired), so two tests that loop 200 admissions
failed locally in a full run and passed in isolation, purely by import order.

Passing every field explicitly puts the values at the top of pydantic-settings'
precedence, above env and dotenv both. That is what the tests always meant.
"""

from __future__ import annotations

from typing import Any

from pydantic_core import PydanticUndefined

from lectorium_chat.config import Settings


_REQUIRED = {
    "database_url": "postgres://test",
    "s3_bucket": "x",
    "s3_region": "us-east-1",
}


def settings_from_model_defaults(**overrides: Any) -> Settings:
    """A `Settings` built from the model's declared defaults, environment-proof."""
    fields: dict[str, Any] = {}
    for name, field in Settings.model_fields.items():
        if field.default is not PydanticUndefined:
            fields[name] = field.default
        elif field.default_factory is not None:
            fields[name] = field.default_factory()  # type: ignore[call-arg]
    fields.update(_REQUIRED)
    fields.update(overrides)
    return Settings(_env_file=None, **fields)
