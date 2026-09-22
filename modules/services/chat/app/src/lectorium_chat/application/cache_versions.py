"""Re-export cache_versions from domain.cache_versions."""

from lectorium_chat.domain.cache_versions import (  # noqa: F401
    NAMESPACE_DEPS,
    _tags,
    bump,
    bump_for_kinds,
    cache_version_for,
    embed_model_tag,
    initialize_embed_tag,
    set_tag,
    snapshot,
)
