"""Known violation: the domain imports an adapter through a relative import."""

from ..infra import cache as fixture  # noqa: F401
