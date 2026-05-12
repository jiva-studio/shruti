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
| `path_glob`                            | `string` (fnmatch, relative to `--in`) | any           | `outbox/sorted/ru/2024/**` |
| `path_prefix`                          | `string`                          | any                | combines with `path_glob` via AND |
| `has_pdf`                              | `*bool`                           | registry only      | checks `out/artifacts/tracks/{id}/transcript.pdf` via `os.Stat` |
| `kind_tags`                            | `[]string`                        | registry only      | `morning_walk`, `conversation`, `lecture`, …; implies `last_done_stage ≥ metadata` |
| `last_done_stage`                      | `pipeline.Stage`                  | registry only      | the highest stage marked `done` for the track |
| `stage_status`                         | `map[Stage]Status`                | registry only      | e.g. `{review: failed}` to find re-runnable failures |
| `enrich_audit`                         | `bool`                            | registry only      | opt-in; needed for `audit_fallback` and `low_conf_min_segs` |
| `audit_fallback`                       | `*FallbackSpec` (`{min_chunks: int}`) | registry only  | requires `enrich_audit=true` |
| `low_conf_min_segs`                    | `int`                             | registry only      | requires `enrich_audit=true` |
| `size_min`, `size_max`                 | `int64`                           | any                | bytes |
| `discovered_after`, `discovered_before` | `time.Time`                       | registry only      | matches `files.ingested_at` |
| `limit`                                | `int`                             | any                | hard cap on rows; default `1000` |

Notes on the heavier fields:

- `committed` is **not** a separate field. Use `last_done_stage = committed`.
- `enrich_audit=true` reads `out/artifacts/tracks/{id}/transcripts/{lang}/review.json`
  and the chunk artifacts for every candidate. Slow on large corpora —
  reserve for `audit.summary`-driven workflows.

## Validation

`NewSelector` rejects:

- `enrich_audit=false` together with `audit_fallback != nil` or
  `low_conf_min_segs > 0`.
- `source = lake` together with any registry-only filter (`has_pdf`,
  `kind_tags`, `stage_status`, `last_done_stage`, `audit_fallback`,
  `discovered_*`).

## Resolver semantics

The infra resolver lives in `internal/infra/lakeregistry/sqlite/trackselect.go`.

- `source = registry`: SELECT over `files` joined with `stages`, applying
  the filters in SQL. PDF presence is checked with `os.Stat`. Audit
  enrichment is a separate disk read per track, lazily applied.
- `source = lake`: walks `--in` for `*.mp3`, excludes paths already in
  `files`, derives language from the canonical `outbox/sorted/<lang>/`
  layout, then applies `path_glob` / `path_prefix` / `size_*`.
- `source = both`: union, registry rows take precedence on path collision.

Result rows:

```
Selected {
  Path        string
  TrackId     track.Id        // empty for source=lake
  Language    string
  HasPDF      bool            // false for source=lake
  LastDone    pipeline.Stage
  KindTag     string
  AuditCount  AuditMetrics    // populated only when EnrichAudit=true
}
```

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
