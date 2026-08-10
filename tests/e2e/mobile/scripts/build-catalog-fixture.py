#!/usr/bin/env python3
"""Derive the committed E2E catalog fixture from a published catalog snapshot.

`fixtures/content.db` is a TEST ASSET, not a build output: it is committed, and
the suite reads it as-is. This script is what a human runs — deliberately —
when the corpus has to move, and its output is reviewed as part of that commit.
`prepare-fixtures.sh` never calls it.

Why a trimmed subset instead of the published catalog:

  * Size. The published catalog is ~28 MB; the subset is small enough to live
    in git.
  * Decidability. The Search landing picks its topic tiles with a shuffle, so a
    spec that opens "the first tile" opens a RANDOM topic. Against the full
    catalog a topic may hold lectures in only one language, so the same commit
    passes or fails depending on the shuffle and on what was published that day
    (Qase 36 / 45 / 150 / 163). The subset keeps only topics that carry
    lectures in BOTH content languages, so every tile is decidable in both
    directions and the assertion no longer depends on the draw.

The subset is chosen by explicit, sorted rules — no sampling, no clock — so a
rebuild from the same snapshot reproduces the same file.

Usage:
    scripts/build-catalog-fixture.py [--source PATH] [--out PATH]

The source defaults to the local lake output. Any version-addressed published
catalog works: `public/db/shruti.{version}.db` is immutable per version.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
E2E_ROOT = HERE.parent
REPO_ROOT = E2E_ROOT.parents[2]

LAKE_CATALOG = "resources/lake-out/artifacts/catalog/current.db"
DEFAULT_SOURCES = (REPO_ROOT / LAKE_CATALOG, REPO_ROOT.parent.parent / LAKE_CATALOG)
DEFAULT_OUT = E2E_ROOT / "fixtures/content.db"

# --------------------------------------------------------------------------- #
#                              selection budget                               #
# --------------------------------------------------------------------------- #

CONTENT_LANGUAGES = ("en", "ru")

# Every kept topic must carry lectures in EVERY content language, so a topic
# tile is never empty and never single-language whichever way the landing's
# shuffle falls. One is enough to decide the assertion; the ranking below then
# prefers the better-stocked topics.
MIN_TRACKS_PER_TOPIC_PER_LANG = 1
TOPICS = 24
TRACKS_PER_TOPIC_PER_LANG = 6

# Per (source, language). The library specs pin `source_dsicuBsFvinZ`
# (Bhagavad-gita) and page through it, so it needs more than one page
# (PAGE_SIZE = 50); the filters spec swaps to Caitanya-caritamrita Madhya-lila
# and re-sorts there, so that one needs several rows too.
TRACKS_PER_SOURCE_LANG = 30
SOURCE_QUOTAS = {
    "source_dsicuBsFvinZ": {"en": 160, "ru": 90},  # BG
    "source_NoY8sAlXF1IT": {"en": 90, "ru": 90},  # SB
    "source_TjXzVgg41Z4s": {"en": 60, "ru": 30},  # CC Madhya
}

TRACKS_PER_COLLECTION = 10
WISDOM_PER_TOPIC_LANG = 2

# Tracks the fixtures reference by id and that therefore must survive the trim:
# the seeded playlists from modules/tools/screenshots/generate-fixtures/tracks.ts
# plus the outline/topic-chip track of Qase 62. Kept in sync by the assertion
# below — a rebuild fails loudly rather than dropping one silently.
PINNED_TRACKS = (
    # EN playlist
    "track_0M6TgFqYKo01",
    "track_0aDNopWvLFpq",
    "track_0CeTlz6QFX6b",
    "track_0JkscmDgrJ2A",
    "track_0dRAV1Swc3ak",
    "track_6WmfTZDnwivk",
    "track_02D0Bp1GSaVz",
    "track_0ABXho7APl2m",
    "track_0AphX6MLtwU9",
    # RU playlist
    "track_95Z39JrFM1MQ",
    "track_k1a4Ah1CZ8ac",
    "track_7OILnakrziEB",
    "track_NHsgDTYRJf6J",
    "track_F79Jy9lTKByn",
    "track_G3M4xu0yncJN",
    "track_064LFEidL3To",
    "track_07z0KklOp0CQ",
    "track_0IMg8A6Mwvwk",
    # Qase 62: "Как очистить ум" — topic chips + lecture outline
    "track_2VQqmis6tnmR",
)

# Tables copied whole (dictionaries and curated editorial data — all small).
WHOLE_TABLES = (
    "migrations",
    "languages",
    "authors",
    "locations",
    "sources",
    "tags",
    "settings",
    "collections",
    "collection_groups",
    "collection_group_items",
    "collection_tags",
)

CYRILLIC = re.compile("[Ѐ-ӿ]")
LATIN = re.compile("[A-Za-z]")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def script_of(title: str, language: str) -> bool:
    """The script a title must be in for its content language.

    The language specs read the SCRIPT of the rendered titles as the signal
    that a surface is scoped to the library language. A Russian lecture titled
    in Latin (or vice versa) makes that signal ambiguous, so the fixture
    refuses to carry one.
    """
    if language == "ru":
        return bool(CYRILLIC.search(title))
    return not CYRILLIC.search(title) and bool(LATIN.search(title))


def pick(rows, key, quota):
    """First `quota` rows per bucket, preserving the query's order."""
    out, seen = [], {}
    for row in rows:
        bucket = key(row)
        if seen.get(bucket, 0) >= quota(bucket):
            continue
        seen[bucket] = seen.get(bucket, 0) + 1
        out.append(row)
    return out


def select_tracks(src: sqlite3.Connection) -> tuple[list[str], list[str]]:
    """Return (track ids, topic ids) to keep — deterministic, fully ordered."""

    # The pool: visible, single-language, playable lectures whose title is in
    # the script of its language.
    pool: dict[str, str] = {}
    for track_id, language, title in src.execute(
        """SELECT v.track_id, v.language, v.title
             FROM track_variants v JOIN tracks t ON t.id = v.track_id
            WHERE t.hidden = 0 AND v.audio_path IS NOT NULL
              AND v.language IN (?, ?)
            ORDER BY v.track_id""",
        CONTENT_LANGUAGES,
    ):
        if not script_of(title, language):
            continue
        pool[track_id] = language

    # Topics that carry lectures in BOTH languages, ranked by how much of the
    # seeded playlists they cover (the Home listening shelves are derived from
    # listening history, and the track sheet renders a lecture's topic chips),
    # then by the curated onboarding order, then by how well stocked they are.
    curated = []
    row = src.execute("SELECT value FROM settings WHERE key = 'onboarding.topics'").fetchone()
    if row:
        try:
            curated = [t for t in json.loads(row[0]) if isinstance(t, str)]
        except json.JSONDecodeError:
            curated = []

    per_topic: dict[str, dict[str, list[str]]] = {}
    for track_id, topic_id in src.execute(
        "SELECT track_id, topic_id FROM track_topics ORDER BY topic_id, track_id"
    ):
        if track_id not in pool:
            continue
        per_topic.setdefault(topic_id, {"en": [], "ru": []})[pool[track_id]].append(track_id)

    known_topics = {t for (t,) in src.execute("SELECT DISTINCT id FROM topics")}
    eligible = sorted(
        topic
        for topic, by_lang in per_topic.items()
        if topic in known_topics
        and all(len(by_lang[lang]) >= MIN_TRACKS_PER_TOPIC_PER_LANG for lang in CONTENT_LANGUAGES)
    )
    pinned = set(PINNED_TRACKS)
    ranked = sorted(
        eligible,
        key=lambda t: (
            -sum(1 for lang in CONTENT_LANGUAGES for x in per_topic[t][lang] if x in pinned),
            curated.index(t) if t in curated else len(curated),
            -min(len(per_topic[t][lang]) for lang in CONTENT_LANGUAGES),
            t,
        ),
    )
    topics = sorted(ranked[:TOPICS])

    keep: set[str] = {t for t in PINNED_TRACKS if t in pool}

    for topic in topics:
        for lang in CONTENT_LANGUAGES:
            keep.update(per_topic[topic][lang][:TRACKS_PER_TOPIC_PER_LANG])

    # Per-source coverage, in reference order, so the library reads like the
    # real one (sorted by shloka) and a verse-reference query still narrows.
    source_rows = [
        (track_id, source_id, pool[track_id])
        for track_id, source_id in src.execute(
            """SELECT DISTINCT r.track_id, r.source_id
                 FROM track_references r JOIN track_variants v ON v.track_id = r.track_id
                ORDER BY r.source_id, v.sort_reference, r.track_id"""
        )
        if track_id in pool
    ]
    keep.update(
        row[0]
        for row in pick(
            source_rows,
            key=lambda row: (row[1], row[2]),
            quota=lambda b: SOURCE_QUOTAS.get(b[0], {}).get(b[1], TRACKS_PER_SOURCE_LANG),
        )
    )

    # Collection coverage, in curated order, scoped to the collection's own
    # language — a collection card must never open onto an empty list.
    collection_rows = [
        (track_id, collection_id, language)
        for collection_id, language, track_id in src.execute(
            """SELECT collection_id, collection_language, track_id
                 FROM collection_tracks
                ORDER BY collection_id, collection_language, position, track_id"""
        )
        if pool.get(track_id) == language
    ]
    keep.update(
        row[0]
        for row in pick(
            collection_rows,
            key=lambda row: (row[1], row[2]),
            quota=lambda _b: TRACKS_PER_COLLECTION,
        )
    )

    return sorted(keep), topics


def build(source: Path, out: Path) -> dict:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    src.execute("PRAGMA query_only = 1")

    missing = [t for t in PINNED_TRACKS if not src.execute(
        "SELECT 1 FROM track_variants WHERE track_id = ?", (t,)
    ).fetchone()]
    if missing:
        sys.exit(
            f"snapshot is missing pinned tracks: {', '.join(missing)}\n"
            "Update PINNED_TRACKS (and the fixtures that reference them) first."
        )

    tracks, topics = select_tracks(src)

    tmp = Path(tempfile.mkdtemp(prefix="catalog-fixture-")) / "content.db"
    dst = sqlite3.connect(tmp)
    dst.execute("PRAGMA page_size = 4096")
    dst.execute("PRAGMA journal_mode = DELETE")

    # Recreate the published schema verbatim: the app validates against it, and
    # a hand-written copy would drift from the catalog migrations.
    ddl = src.execute(
        """SELECT type, name, sql FROM sqlite_master
            WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE 'tracks_search_%'
            ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"""
    ).fetchall()
    for _type, _name, sql in ddl:
        dst.execute(sql)

    def copy(table: str, where: str = "", params: tuple = ()) -> int:
        columns = [r[1] for r in src.execute(f"PRAGMA table_info('{table}')")]
        cols = ", ".join(f'"{c}"' for c in columns)
        order = " ORDER BY " + cols if table != "tracks_search" else ""
        rows = src.execute(f'SELECT {cols} FROM "{table}" {where}{order}', params).fetchall()
        dst.executemany(
            f'INSERT INTO "{table}" ({cols}) VALUES ({", ".join("?" * len(columns))})', rows
        )
        return len(rows)

    counts: dict[str, int] = {}
    for table in WHOLE_TABLES:
        counts[table] = copy(table)

    ids = "(" + ", ".join("?" * len(tracks)) + ")"
    for table, column in (
        ("tracks", "id"),
        ("track_variants", "track_id"),
        ("track_audio", "track_id"),
        ("track_references", "track_id"),
        ("track_tags", "track_id"),
        ("collection_tracks", "track_id"),
    ):
        counts[table] = copy(table, f"WHERE {column} IN {ids}", tuple(tracks))

    topic_ids = "(" + ", ".join("?" * len(topics)) + ")"
    counts["topics"] = copy("topics", f"WHERE id IN {topic_ids}", tuple(topics))
    counts["track_topics"] = copy(
        "track_topics",
        f"WHERE track_id IN {ids} AND topic_id IN {topic_ids}",
        tuple(tracks) + tuple(topics),
    )

    # The full-text index is copied row for row (FTS4 rebuilds its own shadow
    # tables from the inserts) so search behaves exactly as it does in the app.
    counts["tracks_search"] = 0
    for content, track_id, kind in src.execute(
        f"SELECT content, track_id, kind FROM tracks_search WHERE track_id IN {ids}"
        " ORDER BY track_id, kind",
        tuple(tracks),
    ):
        dst.execute(
            "INSERT INTO tracks_search (content, track_id, kind) VALUES (?, ?, ?)",
            (content, track_id, kind),
        )
        counts["tracks_search"] += 1

    wisdom = pick(
        src.execute(
            f"""SELECT id, topic_id, language FROM daily_wisdom
                 WHERE track_id IN {ids} AND topic_id IN {topic_ids}
                 ORDER BY topic_id, language, id""",
            tuple(tracks) + tuple(topics),
        ).fetchall(),
        key=lambda row: (row[1], row[2]),
        quota=lambda _b: WISDOM_PER_TOPIC_LANG,
    )
    wisdom_ids = [row[0] for row in wisdom]
    counts["daily_wisdom"] = copy(
        "daily_wisdom",
        "WHERE id IN (" + ", ".join("?" * len(wisdom_ids)) + ")",
        tuple(wisdom_ids),
    )

    # Asset digests: the per-track ones we kept, plus the collection/topic
    # covers (no track_id) the landing renders.
    counts["asset_hashes"] = copy(
        "asset_hashes", f"WHERE track_id IS NULL OR track_id IN {ids}", tuple(tracks)
    )

    # Collections and groups whose every track was trimmed away would render an
    # empty shelf; drop them rather than ship a card that opens onto nothing.
    dst.execute(
        """DELETE FROM collections WHERE (id, language) NOT IN
             (SELECT collection_id, collection_language FROM collection_tracks)"""
    )
    dst.execute(
        """DELETE FROM collection_group_items WHERE (group_language, collection_id) NOT IN
             (SELECT language, id FROM collections)"""
    )
    dst.execute(
        """DELETE FROM collection_groups WHERE (id, language) NOT IN
             (SELECT group_id, group_language FROM collection_group_items)"""
    )
    for table in ("collections", "collection_groups", "collection_group_items"):
        counts[table] = dst.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    dst.commit()
    verify(dst, tracks, topics)
    dst.execute("VACUUM")
    dst.commit()
    dst.close()
    src.close()

    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(tmp, out)
    shutil.rmtree(tmp.parent, ignore_errors=True)
    return {"tracks": len(tracks), "topics": len(topics), **counts}


def verify(dst: sqlite3.Connection, tracks: list[str], topics: list[str]) -> None:
    """The properties the specs depend on. A rebuild that loses one fails here,
    where it is cheap, instead of in an 11-minute suite run."""
    for topic in topics:
        for language in CONTENT_LANGUAGES:
            n = dst.execute(
                """SELECT count(*) FROM track_topics tt JOIN track_variants v ON v.track_id = tt.track_id
                    WHERE tt.topic_id = ? AND v.language = ?""",
                (topic, language),
            ).fetchone()[0]
            assert n >= MIN_TRACKS_PER_TOPIC_PER_LANG, f"topic {topic} has {n} {language} lectures"

    for track_id, language, title in dst.execute(
        "SELECT track_id, language, title FROM track_variants"
    ):
        assert script_of(title, language), f"{track_id}: {language} title not in its script: {title}"

    langs = [r[0] for r in dst.execute("SELECT DISTINCT language FROM track_variants ORDER BY 1")]
    assert langs == sorted(CONTENT_LANGUAGES), f"content languages drifted: {langs}"

    for collection_id, language in dst.execute("SELECT id, language FROM collections"):
        n = dst.execute(
            """SELECT count(*) FROM collection_tracks ct JOIN track_variants v ON v.track_id = ct.track_id
                WHERE ct.collection_id = ? AND ct.collection_language = ? AND v.language = ?""",
            (collection_id, language, language),
        ).fetchone()[0]
        assert n > 0, f"collection {collection_id}/{language} has no lecture in its own language"

    missing = [t for t in PINNED_TRACKS if t not in set(tracks)]
    assert not missing, f"pinned tracks dropped: {missing}"

    # Qase 62 reads this lecture's topic chips and its outline off the track
    # sheet, so both have to survive the trim.
    chips, outline = dst.execute(
        """SELECT (SELECT count(*) FROM track_topics WHERE track_id = v.track_id),
                  length(v.outline)
             FROM track_variants v WHERE v.track_id = 'track_2VQqmis6tnmR'"""
    ).fetchone()
    assert chips > 0, "track_2VQqmis6tnmR kept no topic (Qase 62 reads its topic chips)"
    assert outline, "track_2VQqmis6tnmR has no outline (Qase 62 reads its chapters)"

    # The Home listening shelves are derived from the seeded playlists, so each
    # language's playlist needs lectures that still carry a topic.
    for language in CONTENT_LANGUAGES:
        n = dst.execute(
            f"""SELECT count(DISTINCT tt.track_id) FROM track_topics tt
                  JOIN track_variants v ON v.track_id = tt.track_id
                 WHERE v.language = ? AND tt.track_id IN
                       ({", ".join("?" * len(PINNED_TRACKS))})""",
            (language, *PINNED_TRACKS),
        ).fetchone()[0]
        assert n > 0, f"no seeded {language} playlist lecture kept a topic"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if args.source is None:
        args.source = next((p for p in DEFAULT_SOURCES if p.exists()), DEFAULT_SOURCES[0])
    if not args.source.exists():
        sys.exit(
            f"no catalog snapshot at {args.source}\n"
            "Pass --source with a published catalog (public/db/shruti.<version>.db)."
        )

    counts = build(args.source, args.out)
    digest = sha256(args.out)
    version = re.search(r"\d{14}", args.source.name)
    meta = {
        "source": {
            "file": args.source.name,
            # Published catalogs are version-addressed and immutable per
            # version, so this pins what the fixture was carved out of.
            "version": int(version.group()) if version else None,
            "sha256": sha256(args.source),
        },
        "generator": "scripts/build-catalog-fixture.py",
        "sha256": digest,
        "bytes": args.out.stat().st_size,
        "rows": counts,
    }
    meta_path = args.out.with_suffix(".db.json")
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")

    print(f">> {args.out} ({args.out.stat().st_size:,} bytes)")
    print(f">> sha256 {digest}")
    print(f">> {meta_path}")


if __name__ == "__main__":
    main()
