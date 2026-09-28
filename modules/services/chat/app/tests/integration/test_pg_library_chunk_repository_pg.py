"""`PgLibraryChunkRepository`'s SQL, run by Postgres with pgvector and pg_trgm.

Every row is written under an embed model no deployment uses, and every query
filters on it, so the tests see only their own rows. Marked `needs_db`.
"""

from __future__ import annotations

import asyncpg
import pytest
from pgvector.asyncpg import register_vector

from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.infra.repositories.pg_library_chunk_repository import (
    PgLibraryChunkRepository,
)

pytestmark = pytest.mark.needs_db

_MODEL = "itest-library-model"
_DIM = 256
_ROUTER = EmbeddingTableRouter(_DIM)


def _vec(*axes: int) -> list[float]:
    v = [0.0] * _DIM
    for a in axes:
        v[a] = 1.0
    return v


# item_id, kind, source_id, tokens, author_id, doc_date, lang, segment, text, addr, embedding
_ROWS = [
    ("v-bg-2-13", "verse", "bg", "2.13", None, None, "ru", None,
     "Как воплощенная душа проходит через детство", "БГ 2.13", _vec(0)),
    ("v-bg-2-13", "verse", "bg", "2.13", None, None, "en", None,
     "As the embodied soul continuously passes", "BG 2.13", _vec(0)),
    ("c-bg-2-13", "commentary", "bg", "2.13", "acbsp", "1972-01-01", "ru", 1,
     "Комментарий о переселении души", "БГ 2.13", _vec(0, 1)),
    ("c-bg-2-13", "commentary", "bg", "2.13", "acbsp", "1972-01-01", "ru", 0,
     "Начало комментария", "БГ 2.13", _vec(1)),
    ("c-bg-2-13-other", "commentary", "bg", "2.13", None, None, "ru", 0,
     "Другой комментарий", "БГ 2.13", _vec(2)),
    ("l-1970", "letter", None, "", "acbsp", "1970-05-05", "en", 0,
     "Letter about chanting", "Letter 1970", _vec(3)),
    # A chunk without an embedding: the lexical lane must not surface it.
    ("v-sb-1-1-1", "verse", "sb", "1.1.1", None, None, "ru", None,
     "Душа без вектора", "ШБ 1.1.1", None),
]


@pytest.fixture
async def repo(chat_schema_url: str):
    pool = await asyncpg.create_pool(
        chat_schema_url, min_size=1, max_size=2, init=register_vector,
    )
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM chunks WHERE embed_model = $1", _MODEL)
        for (item, kind, src, tok, author, date, lang, seg, text, addr, emb) in _ROWS:
            chunk_id = await conn.fetchval(
                """
                INSERT INTO chunks (item_id, kind, source_id, tokens, author_id,
                                    doc_date, lang, segment_index, text, addr_label,
                                    embed_model)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                RETURNING id
                """,
                item, kind, src, tok, author, date, lang, seg, text, addr, _MODEL,
            )
            if emb is not None:
                await conn.execute(
                    f"INSERT INTO {_ROUTER.chunk_table} (chunk_id, embedding, kind, lang)"
                    " VALUES ($1, $2, $3, $4)",
                    chunk_id, emb, kind, lang,
                )
    yield PgLibraryChunkRepository(pool=pool, embed_model=_MODEL, router=_ROUTER)
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM chunks WHERE embed_model = $1", _MODEL)
    await pool.close()


async def test_ann_search_ranks_by_cosine_within_the_asked_kinds(repo) -> None:
    got = await repo.search_library_by_embedding(
        _vec(0), kinds=["verse", "commentary"], lang="ru", top_k=10,
    )
    assert [(h.chunk.item_id, h.chunk.segment_index) for h in got][:2] == [
        ("v-bg-2-13", None), ("c-bg-2-13", 1),
    ]
    assert got[0].score == pytest.approx(1.0)
    assert got[1].score == pytest.approx(2 ** -0.5)
    assert {h.chunk.lang for h in got} == {"ru"}
    assert "letter" not in {h.chunk.item_kind for h in got}


async def test_ann_search_applies_the_optional_filters(repo) -> None:
    by_author = await repo.search_library_by_embedding(
        _vec(1), kinds=["commentary"], author_id="acbsp", top_k=10,
    )
    assert {h.chunk.item_id for h in by_author} == {"c-bg-2-13"}
    dated = await repo.search_library_by_embedding(
        _vec(3), kinds=["letter", "commentary"],
        date_from="1970-01-01", date_to="1971-01-01", top_k=10,
    )
    assert [h.chunk.item_id for h in dated] == ["l-1970"]
    elsewhere = await repo.search_library_by_embedding(
        _vec(0), kinds=["verse"], source_id="sb", top_k=10,
    )
    assert elsewhere == []


async def test_ann_search_refuses_an_unknown_kind(repo) -> None:
    with pytest.raises(ValueError, match="unknown chunk kind"):
        await repo.search_library_by_embedding(_vec(0), kinds=["verse'; --"])


async def test_lexical_search_matches_russian_morphology_and_skips_unembedded_rows(
    repo,
) -> None:
    got = await repo.search_chunks_lexical(
        "души", _vec(0, 1), kinds=["verse", "commentary"], lang="ru",
    )
    ids = {h.chunk.item_id for h in got}
    assert "c-bg-2-13" in ids  # «души» ~ «душа» via the russian stemmer
    assert "v-sb-1-1-1" not in ids  # no embedding row
    hit = next(h for h in got if h.chunk.item_id == "c-bg-2-13" and h.chunk.segment_index == 1)
    assert hit.score == pytest.approx(1.0)


async def test_lexical_search_matches_the_address_by_trigram(repo) -> None:
    got = await repo.search_chunks_lexical(
        "BG 2.13", _vec(0), kinds=["verse"], lang="en",
    )
    assert [h.chunk.item_id for h in got] == ["v-bg-2-13"]


async def test_lookup_by_address_orders_segments_nulls_first(repo) -> None:
    got = await repo.get_chunks_by_addr_label(
        "БГ 2.13", kinds=["verse", "commentary"], lang="ru",
    )
    assert [c.segment_index for c in got][0] is None
    assert [c.segment_index for c in got][1:] == sorted(c.segment_index for c in got[1:])
    assert all(c.lang == "ru" for c in got)


async def test_lookup_by_verse_puts_the_attributed_commentary_first(repo) -> None:
    got = await repo.get_chunks_by_verse(
        source_id="bg", tokens="2.13", kinds=["commentary"], lang="ru",
    )
    assert [(c.item_id, c.segment_index) for c in got] == [
        ("c-bg-2-13", 0), ("c-bg-2-13", 1), ("c-bg-2-13-other", 0),
    ]


async def test_lookup_by_target_maps_the_reference_kind(repo) -> None:
    verse = await repo.get_chunks_by_target(ref_kind="verse", target_id="v-bg-2-13", lang="en")
    assert [(c.item_kind, c.lang) for c in verse] == [("verse", "en")]
    doc = await repo.get_chunks_by_target(ref_kind="document", target_id="c-bg-2-13")
    assert [c.segment_index for c in doc] == [0, 1]
    assert await repo.get_chunks_by_target(ref_kind="media", target_id="x") == []
