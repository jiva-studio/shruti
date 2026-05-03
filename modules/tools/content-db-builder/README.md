# content-db-builder

Builds the prebuilt Shruti content SQLite database from CouchDB and uploads artefacts (DB, transcripts) to AWS S3.

## Prerequisites

- Node.js 20+
- Access to the source CouchDB instance (`dictionary`, `tracks`, `transcripts` databases)
- AWS S3 credentials for the `shruti-engine` bucket

The Yandex mirror is intentionally **out of scope** for this tool — it will be a separate rclone sync once AWS ingestion has stabilised.

Copy `.env.example` to `.env` and fill in the values. The defaults point at the public CouchDB at `couchdb.shruti.local` with the `shruti:shruti` credentials from the service's docker-compose.

## Commands

```bash
# 1. Build shruti.{YYYYMMDDHHmmss}.db under ./out/public/db/
npm run build

# 2. Export all transcripts as JSON files under ./out/public/tracks/{trackId}/transcripts/{language}.json
npm run export:transcripts

# 3. Upload the entire ./out/ tree to AWS S3 + update config.json
npm run upload

# Run all three in order:
npm run all
```

The output layout mirrors the bucket layout, so `upload` is just a verbatim
tree sync — `./out/public/db/shruti.X.db` lands at
`s3://<bucket>/public/db/shruti.X.db`.

## How it works

1. **Migrations.** SQL files under `migrations/` are applied in lexicographic
   order to a fresh SQLite file. Each file is expected to start with a
   `-- scheme: YYYYMMDD` comment; that value is stored in the `migrations`
   row. The mobile app reads the content DB's scheme from the last
   `migrations` row (`SELECT scheme FROM migrations ORDER BY name DESC LIMIT 1`).

2. **Import from CouchDB.** `importFromCouch.ts` reads the `dictionary` and
   `tracks` CouchDB databases, maps the documents onto the normalized SQLite
   schema, and inserts everything in a single transaction.
   - `type: "duration"` and `type: "sort"` dictionary docs are intentionally
     skipped — they are UI constants, not data.
   - `audio.clean` is ignored; only `audio.original` is stored.
   - For each track, one row is emitted per language into `track_variants`,
     combining title + audio path + transcript path for that language.

3. **Export transcripts.** `exportTranscripts.ts` reads the `transcripts`
   CouchDB database and writes each document as a JSON file on disk,
   under `tracks/{trackId}/transcripts/{language}.json`. The transcript
   content is **not** stored in the SQLite DB — only the path (in
   `track_variants.transcript_path`) is.

4. **Upload.** `uploadToS3.ts` walks the output tree and PUTs every file to
   the configured S3 targets (AWS + optional Yandex mirror). After the tree
   is uploaded, it fetches each target's `public/config.json`, merges in the
   new `{ version, scheme }` entry, keeps the most recent 5, and writes it
   back.

## Adding a new migration

1. Create `migrations/NNN_description.sql` with a leading `-- scheme: YYYYMMDD`
   comment.
2. Bump the `scheme` value in `modules/db-scheme.json` to match.
3. Add the matching `docs/db/scheme.{YYYYMMDD}.md` file.
4. Run `npm run all` to produce a new DB, push it, and update `config.json`.
5. Run `bash modules/db-sync.sh` in the repo to refresh bundled DBs for the
   mobile app's native assets.
