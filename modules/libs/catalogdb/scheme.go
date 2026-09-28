// Package catalogdb is the published language of the catalog: the schema of
// current.db and library.db, the migrations that produce it, and the queries
// that read it. It depends on database/sql only, so it runs over either SQLite
// driver (mattn/go-sqlite3 or modernc.org/sqlite).
package catalogdb

// Scheme is the catalog schema version clients gate on. The mobile app reads it
// from `migrations` (the newest named row with a scheme) and loads only a
// catalog whose scheme it was built for; config.json advertises it next to each
// published version. It must equal modules/db-scheme.json.
const Scheme = 20260621
