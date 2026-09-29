# share-transcript

Renders a printable **transcript PDF** for one track on demand and caches it
in the storage zone. The renderer (reportlab) lives here; the chat service
does not generate PDFs.

The client (the mobile Library share menu, or the chat share card) calls
this service when the user taps "share PDF", exactly like `share-audio`
is called to cut an excerpt. The service does **not** read the catalog:
the caller sends the track's cover metadata, its outline and the storage key
of the transcript to render.

## API

`POST /pdf`  (reached as `/share/transcripts/pdf` behind Caddy)

```json
{
  "track_id": "abc123",
  "lang": "ru",
  "transcript_key": "public/tracks/abc123/transcripts/ru.json",
  "title": "…", "author_name": "…", "date": "1972-08-01",
  "location_name": "…", "references": [{"short_name":"SB","tokens":"1.2.3"}],
  "tags": ["…"],
  "outline": [{"title": "…", "start": 0, "end": 60000}]
}
```

→ `{"track_id","lang","url","ready"}` — `url` is the public PDF.

Client-initiated + async, same contract as share-audio's `/excerpts`:

- **Warm** (PDF in the store at the current renderer version): `200
  {ready:true}` — `url` is live now.
- **Cold**: do the cheap checks synchronously (a missing transcript →
  `404 transcript_unavailable`), then **dispatch the render to a background
  task** (GET transcript → reportlab → PUT PDF → PUT version marker) and
  return `202 {ready:false}` with the predicted URL. The render is coalesced
  per output key.

The PDF lives at `public/tracks/<id>/exports/<lang>.pdf`, the key the app
predicts, so the client polls that URL (`resolveShareArtifact` /
`pollUntilReady`) until the object goes live, then downloads + shares. The
storage zone keeps no custom metadata, so the renderer version that produced
the PDF is the sidecar object `<pdf key>.version`; a missing or older marker
re-renders the PDF in place.

`GET /healthz` → `{"status":"ok","build":{…}}`.

## Config (env)

| var | default | purpose |
|-----|---------|---------|
| `STORAGE_ZONE` | — (required) | Bunny storage zone |
| `STORAGE_KEY` | — (required) | storage-zone password |
| `STORAGE_ENDPOINT` | `https://storage.bunnycdn.com` | storage API host |
| `PDFS_PUBLIC_BASE` | — (required) | pull zone the returned URL is composed from |
| `PORT` | `8084` | listen port |

The service refuses to start without the three required values.

## Tests

```bash
cd app && pip install -e ".[dev]" && python -m pytest tests -q && ruff check .
```
