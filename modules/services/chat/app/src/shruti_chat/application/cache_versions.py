"""Re-export cache_versions from domain.cache_versions."""

from shruti_chat.domain.cache_versions import (  # noqa: F401
    NAMESPACE_DEPS,
    bump,
    bump_for_kinds,
    cache_version_for,
    embed_model_tag,
    initialize_embed_tag,
    set_tag,
    snapshot,
)
