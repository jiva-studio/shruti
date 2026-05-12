# Changelog

## v2.0.0 — BREAKING

A coordinated refactor that gives every MCP tool one predictable shape:
one envelope, two dispatch modes (sync / async), one verb taxonomy, one
selector entry, dot-namespacing. ~55 tools collapse to ~27. The only
consumer is Claude Code, so this releases as a clean break — no
deprecation aisle.

### Breaking

**Tool names are dot-namespaced** (was `tool_name`, now `<resource>.<verb>`).
Permission allowlists in client `settings.local.json` files must be
regenerated for the new names.

Full rename map:

| Pre-v2 | v2 |
|---|---|
| `pipeline_run` | `pipeline.run` |
| `tracks_select` | `tracks.preview` |
| `tracks_tag_audio_bulk` | `pipeline.run op=audio_tag` |
| `tracks_align_pdf_bulk` | `pipeline.run op=align_pdf` |
| `tracks_titles_refresh` | `pipeline.run op=titles_refresh` |
| `audit_review` | `pipeline.run op=audit` (async) **or** `audit.summary` (sync) |
| `audit_track` | `audit.track` |
| `track_ingest`, `track_status`, `track_validate`, `track_commit` | `track.ingest`, `.status`, `.validate`, `.commit` |
| `track_set_metadata` | `track.metadata.set` |
| `track_tag_audio` | `track.audio.tag` |
| `audio_normalize` | `track.audio.normalize` |
| `metadata_extract` | `track.metadata.extract` |
| `transcript_create` | `track.transcript.create` |
| `transcript_review` | `track.transcript.review` |
| `transcript_align_pdf` | `track.transcript.align_pdf` |
| `runs_list`, `run_status`, `run_wait`, `run_cancel` | `runs.list`, `runs.status`, `runs.wait`, `runs.cancel` |
| `catalog_refresh`, `catalog_status`, `catalog_publish` | `catalog.refresh`, `catalog.status`, `catalog.publish` |
| `<dict>_create/update/delete/delete_locale/list/get` | dotted form |
| `<dict>_find` | `<dict>.resolve` (renamed: surfaces the LLM-fuzzy nature) |
| `admin_config_get`, `admin_config_set` | `admin.config.get`, `admin.config.set` |
| `provider_list` | `provider.list` |

**Response envelope is now uniform.** Every tool returns exactly one of:

```jsonc
{"ok": true,  "kind": "<tool>", "result": <payload>}            // sync
{"ok": true,  "kind": "<tool>", "run": {id, kind, state, ...}}  // async
{"ok": false, "kind": "<tool>", "error": {code, message, details}}
```

Error codes are a closed set: `invalid_argument`, `not_found`,
`conflict`, `validation_failed`, `dependency_failed`, `internal`.

**Per-track tools are sync-only.** The `async=true` flag is gone.
For batch / fan-out, use `pipeline.run op=…`.

**Bulk tools removed.** `tracks_tag_audio_bulk`, `tracks_align_pdf_bulk`,
`tracks_titles_refresh`, and the async path of `audit_review` are all
folded into `pipeline.run` via the new `op` parameter.

### Added

**Per-stage re-run on a selector**. `pipeline.run` accepts:
- `only=<stage>` — wipe just that stage + its dependents, run only it.
  Rolls back committed catalog rows for upstream stages first.
  Rejects `only=ingested` (re-hashing the file mints a new track_id →
  orphans every catalog row; use `force=true` with a fresh path).
- `from=<stage> up_to=<Y>` — partial pipeline range.

**SQLite-backed run registry** at `out/artifacts/lake/runs.db`. Runs
survive daemon restarts; non-terminal rows from the prior process are
reconciled to `state=failed, error="daemon restart"` on boot. The
`kind` column is opaque TEXT so historical rows from dropped run.Kind
constants still load. Configurable via `runs_db:` in
`shruti-mcp.yaml`.

**`audit.summary`** — sync corpus rollup with top-N cap (default 20,
max 100). For an unbounded walk over thousands of tracks use
`pipeline.run op=audit` async.

### Architecture cleanup

- Admin config moved to a proper application service. The MCP handler
  is a ~110-line dispatcher; validation + dispatch live in
  `internal/application/adminconfig`. New writable paths require one
  declarative entry in `internal/domain/adminconfig/path.go` plus a
  port-method implementation.
- `application/review/usecase.go` decomposed 1054 → 594 lines.
  Pure-function helpers extracted into `chunking.go`, `fallback.go`,
  `boundaries.go`, `aggregate.go`.
- `application/titles/` → `application/title/` (singular, matching the
  ports and infra packages for the same concept).
- File naming sweep: `internal/mcp/tools/*.go` no longer uses
  `snake_case` filenames (Go convention).
- Python script reorg:
  - `scripts/pdf_align_daemon.py` → `scripts/pdf_align/daemon.py`
  - `scripts/razdel_split.py` → `scripts/sentencesplit/razdel.py`
- `track.title.refresh` validates `language` against the en/ru/hi
  whitelist; unknown locales rejected.

### Migration checklist

1. Update client allowlists (`settings.local.json`) to dotted names.
2. Drain any in-flight `runs.list state=running` before deploying — the
   in-memory registry's contents don't carry over to SQLite on first
   boot (workers persist their per-file state in the lake registry, so
   stage progress is preserved; only run-level metadata is lost).
3. Re-fetch tool descriptions in any cached agent context.
4. If you scripted any pre-v2 envelope shape parsing, update to
   `{ok, kind, result|run|error}`.
