"""Redis cache keys are a deployment contract: every replica, old and new, reads
and writes the same entries.

The literals are keys deployed replicas compose for the same parts and tags. A
change to them makes a rolling deploy silently empty the shared L2, and every
replica recomputes what the others already paid for.
"""

from __future__ import annotations

import pytest

from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.application.memo_cache import KVMemoCache
from shruti_chat.domain.cache_versions import embed_model_tag
from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache

PINNED = [
    ("router", {"q": "Кто такой Кришна?", "lang": "ru", "model": "m"},
     "lc:v1:router:0:6c4cd2e3dc3fd9c039ae0188"),
    ("title", {"q": "hello", "model": "m"},
     "lc:v1:title:0:5979cacaf5d63903401fc5ab"),
    ("pg_chunk_search", {"q": [0.1, 0.2], "k": 8, "lang": "en"},
     "lc:v1:pg_chunk_search:f8297151-20260518:1d4270cd02ebae629801beb5"),
    ("track_meta", {"id": "t1"},
     "lc:v1:track_meta:20260520:c9b682ba48f8a74b65a8d647"),
    ("pg_lib_search", {"q": "x", "tags": {"b", "a"}},
     "lc:v1:pg_lib_search:f8297151-20260518:27baf48d78752c9d6011b8d6"),
    ("translated_chunk", ("c1", "ru"),
     "lc:v1:translated_chunk:0-20260518:6dac5d9ef3b9c16f1af7121c"),
    ("chat_attribute", {"k": "lecture_authors", "q": "q", "model": ""},
     "lc:v1:chat_attribute:0:53183390ea69ec2d6edb9ae8"),
]


@pytest.fixture()
def versions() -> CacheVersionRegistry:
    registry = CacheVersionRegistry(
        embed_model_tag=embed_model_tag("openai", "text-embedding-3-small", 1536),
    )
    registry.set_tag("catalog", "20260520")
    registry.set_tag("library", "20260518")
    return registry


@pytest.fixture()
def memo(versions: CacheVersionRegistry) -> KVMemoCache:
    return KVMemoCache(MemoryKVCache(max_entries=8), versions)


@pytest.mark.parametrize(("ns", "parts", "key"), PINNED, ids=[p[0] for p in PINNED])
def test_keys_are_byte_identical_to_the_deployed_format(
    memo: KVMemoCache, ns: str, parts: object, key: str,
) -> None:
    assert memo.make_key(ns, parts) == key


async def test_the_embedding_memo_writes_the_deployed_key(memo: KVMemoCache) -> None:
    async def _vec() -> list[float]:
        return [0.5]

    await memo.cached_embedding(text="t", model="m", ttl_s=60, factory=_vec)
    assert await memo.get("lc:v1:embed_query:f8297151:898f4b4e01517962d099f77e") == b"[0.5]"


def test_a_swap_moves_only_the_namespaces_that_depend_on_it(
    memo: KVMemoCache, versions: CacheVersionRegistry,
) -> None:
    before = {ns: memo.make_key(ns, parts) for ns, parts, _ in PINNED}
    versions.set_tag("catalog", "20260601")
    after = {ns: memo.make_key(ns, parts) for ns, parts, _ in PINNED}
    moved = {ns for ns in before if before[ns] != after[ns]}
    assert moved == {"track_meta"}
