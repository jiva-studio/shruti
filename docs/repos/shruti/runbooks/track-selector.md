# Track selector

The track selector is the unified mechanism for picking a subset of mp3
files for any bulk operation in `shruti-mcp` — pipeline runs, audit
sweeps, bulk re-tagging, bulk PDF alignment, etc. One value object,
one resolver, every batch tool consumes it.

**Why one selector instead of per-tool flags?** The old layout had each
batch tool inventing its own filtering vocabulary: `pipeline.run all=true
up_to=…`, `audit.summary language=ru`, `lake_scan glob=…`,
`track.ingest` (no path, walks lake). Combinations like "every Russian
track stuck before review with no PDF" required stitching multiple
calls and filtering in the agent. The selector flattens that into one
schema with strict AND semantics.

## Sources

The selector picks a `source` that decides where candidates come from:

| Source     | Where candidates come from |
|------------|----------------------------|
| `registry` | the lake-registry `files` table — **only** tracks that have been ingested |
| `lake`     | filesystem walk under `--in`, **excluding** anything already in the registry |
| `both`     | union of the two (default) |

Pick `lake` when you need to find fresh mp3s waiting to be ingested; use
`registry` when you need rich filters that depend on ingest state
(stages, kind tags, PDFs); use `both` for the default "show me
everything" mode.

## Filters

All filters AND together. Empty/zero values mean "no filter". Filters
that depend on registry state silently skip the lake-only side of the
result.

| Field                                  | Type                              | Source restriction | Notes |
|----------------------------------------|-----------------------------------|--------------------|-------|
| `languages`                            | `[]string` (ISO-639)              | any                | matches `files.language` (registry) or path-derived language (lake) |
| `track_ids`                            | `[]string`                        | registry only      | `f.track_id IN (…)`; lake files have no track id, so this drops the lake side under `both` |
| `path_glob`                            | `string` (fnmatch, relative to `--in`) | any           | `outbox/sorted/ru/2024/**` |
| `path_prefix`                          | `string`                          | any                | combines with `path_glob` via AND |
| `has_pdf`                              | `*bool`                           | registry only      | checks `<out>/artifacts/tracks/{id}/transcript.pdf` via `os.Stat` |
| `kind_tags`                            | `[]string`                        | registry only      | `morning_walk`, `conversation`, `lecture`, …; reads the `metadata` stage payload (`kind_tag`) |
| `last_done_stage`                      | `pipeline.Stage`                  | registry only      | the highest stage marked `done` for the track |
| `stage_status`                         | `map[Stage]Status`                | registry only      | e.g. `{reviewed: failed}` to find re-runnable failures |
| `enrich_audit`                         | `bool`                            | registry only      | opt-in; needed for `audit_fallback` and `low_conf_min_segs` |
| `audit_fallback`                       | `*FallbackSpec` (`{min_chunks: int}`) | registry only  | requires `enrich_audit=true`; `min_chunks` must be > 0 |
| `low_conf_min_segs`                    | `int`                             | registry only      | requires `enrich_audit=true` |
| `size_min`, `size_max`                 | `int64`                           | any                | bytes |
| `discovered_after`, `discovered_before` | `time.Time`                       | registry only      | matches `files.ingested_at` |
| `limit`                                | `int`                             | any                | hard cap on rows; default `1000` (`DefaultLimit`) |

Notes on the heavier fields:

- `committed` is **not** a separate field. Use `last_done_stage = committed`.
- `enrich_audit=true` reads each track's review session
  (`Transcripts.ReadReviewSession`) off disk per `(track, language)` to
  tally `AuditMetrics`. Slow on large corpora — reserve for
  `audit.summary`-driven workflows.

## Validation

`NewSelector` defaults `source` to `both` and `limit` to `DefaultLimit`
(1000) when zero, then rejects:

- an unknown `source` value.
- `source = lake` together with any registry-only filter (`has_pdf`,
  `kind_tags`, `stage_status`, `last_done_stage`, `audit_fallback`,
  `low_conf_min_segs`, `discovered_after`, `discovered_before`).
- `enrich_audit=false` together with `audit_fallback != nil` or
  `low_conf_min_segs > 0`.
- `audit_fallback.min_chunks <= 0`.
- negative `size_min` / `size_max`, or `size_max > 0` below `size_min`.
- `discovered_after` later than `discovered_before` when both are set.

## Resolver semantics

The port is `internal/ports/trackselect.Selector` (named `trackselect`,
not `selector`, to avoid colliding with the LLM `catalog.Resolver`). The
SQLite-backed adapter is `TrackSelector` in
`internal/infra/lakeregistry/sqlite/trackselect.go`, wired with the
registry's `*sql.DB`, the lake root (`--in`), the out dir, and the
transcript store.

`Select` runs the registry side first (when `IncludesRegistry()`), then the
lake side (when `IncludesLake()`), capping at `limit`:

- `source = registry`: a single `SELECT … FROM files` applies the
  SQL-friendly filters (`languages`, `track_ids`, `path_prefix`,
  `size_*`, `discovered_*`, and an `EXISTS` per `stage_status` entry).
  Everything else is a **Go post-filter** over the in-memory rows:
  `last_done_stage` (computed from the `stages` table via a fixed stage
  rank), `path_glob`, `has_pdf` (`os.Stat`), `kind_tags` (read from the
  `metadata` stage payload, `variant=''`), and — only when `enrich_audit=true` —
  the audit enrichment + `audit_fallback` / `low_conf_min_segs` filters.
  Because post-filters drop rows, `limit` is applied after enrichment,
  not in SQL.
- `source = lake`: walks `--in` for `*.mp3`, skips `outbox/duplicates`,
  excludes any path already in `files`, derives language from the
  canonical `outbox/sorted/<lang>/` layout (`ru`/`en`/`hi`), then applies
  `path_glob` / `path_prefix` / `size_*` / `languages`. Results are
  sorted by path for stable ordering.
- `source = both`: registry rows first (they own any path collision via
  the `knownPaths` set), then lake rows fill the remaining `limit` room.
  Under `both`, any registry-only filter (`track_ids`, `has_pdf`,
  `kind_tags`, `last_done_stage`, `stage_status`, `audit_*`,
  `discovered_*`) **silently drops the lake side** — `IncludesLake()`
  returns false so unregistered mp3s don't leak through as false
  positives.

Result rows (`trackselect.Selected`):

```
Selected {
  Path         string
  TrackId      track.Id        // empty for lake rows
  Language     string
  HasPDF       bool            // false for lake rows
  LastDone     pipeline.Stage  // empty for lake rows
  KindTag      string          // empty for lake rows
  Size         int64           // os.Stat (lake) or files.size_bytes (registry)
  DiscoveredAt time.Time       // mod time (lake) or files.ingested_at (registry)
  AuditCount   AuditMetrics     // populated only when EnrichAudit=true
}
```

`AuditMetrics` tallies `FallbackChunks`, `LowConfidenceSegs`,
`NoiseFilteredSegs`, and `TotalChunks` from the review session.

## Examples

> All Russian tracks stuck before review (transcribed but not reviewed),
> no PDF (i.e. would actually pay for an LLM pass):
>
> ```
> tracks.preview selector={
>   source: registry,
>   languages: [ru],
>   last_done_stage: transcribed,
>   has_pdf: false,
> }
> ```

> Every track that hit a fallback ≥3 chunks in the last review pass —
> candidates for premium re-run:
>
> ```
> tracks.preview selector={
>   source: registry,
>   enrich_audit: true,
>   audit_fallback: { min_chunks: 3 },
> }
> ```

> Drain whatever's sitting in the lake all the way to committed:
>
> ```
> pipeline.run selector={} up_to=committed
> ```

> Only re-tag the audio of all committed Russian tracks:
>
> ```
> pipeline.run op=audio_tag selector={
>   languages: [ru],
>   last_done_stage: committed,
> }
> ```
