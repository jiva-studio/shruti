# share-transcript

Renders a printable **transcript PDF** for one track on demand and caches it
to S3. The renderer (reportlab) and the outline/TOC generator (LLM) were
moved here out of the chat service — chat no longer owns PDF generation.

The client (the mobile Library share menu, or the chat share card) calls
this service when the user taps "share PDF", exactly like `share-audio`
is called to cut an excerpt. The service does **not** read the catalog:
the caller sends the track's cover metadata + the S3 key of the transcript
to render.

## API

`POST /pdf`  (reached as `/share/transcripts/pdf` behind Caddy)

```json
{
  "track_id": "abc123",
  "lang": "ru",
  "transcript_key": "public/tracks/abc123/transcript.ru.json",
  "title": "…", "author_name": "…", "date": "1972-08-01",
  "location_name": "…", "references": [{"short_name":"SB","tokens":"1.2.3"}],
  "tags": ["…"]
}
```

→ `{"track_id","lang","url","ready"}` — `url` is the public PDF.

Client-initiated + async, same contract as share-audio's `/excerpts`:

- **Warm** (PDF already on the CDN): `200 {ready:true}` — `url` is live now.
- **Cold**: do the cheap checks synchronously (a missing transcript →
  `404 transcript_unavailable`), then **dispatch the render to a background
  task** (GET transcript → ensure outline
  `artifacts/tracks/<id>/outlines/<lang>.<model_tag>.c1.json`, generate via LLM
  on miss → reportlab → PUT) and return `202 {ready:false}` with the
  predicted URL. The render is coalesced per output key.

The outline is generated in two passes (kept in sync with chat's
`track_outline_get`, which shares this cache): a granular fine pass lists
every topic shift, then a merge pass folds consecutive topics into ≤8 coarse
chapters, repeating until at/below the ceiling. The chapter count emerges
from the content rather than a fixed number the LLM ignores. The `.c1` tag
in the cache key is the algorithm version — bump it (here and in chat) to
invalidate outlines from the old single-pass generator.

The predicted URL equals the canonical key the render writes to, so the
client polls that URL (`resolveShareArtifact` / `pollUntilReady`) until the
object goes live, then downloads + shares.

`GET /healthz` → `{"status":"ok","build":{…}}`.

## Config (env)

| var | default | purpose |
|-----|---------|---------|
| `LECTORIUM_S3_BUCKET` / `BUCKET` | — (required) | bucket |
| `AWS_REGION` | `us-east-1` | region |
| `S3_ENDPOINT_URL` | "" | set to Yandex on the RU proxy |
| `PDFS_PUBLIC_BASE` / `LECTORIUM_S3_PUBLIC_BASE` | "" | public CDN base for the returned URL |
| `SOURCE_KEY_PREFIX` | `public/tracks/` | only renders transcripts under this prefix |
| `OPENROUTER_API_KEY` | "" | outline LLM (TOC) |
| `LLM_OUTLINE_MODEL` | `openrouter/google/gemini-2.5-flash-lite` | must match chat so the outline cache is shared |
| `PORT` | `8084` | listen port |

AWS creds come from the standard env chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
