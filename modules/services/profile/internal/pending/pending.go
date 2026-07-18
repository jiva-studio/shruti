// Package pending is the PRODUCER half of the corpus-review pipeline: it
// exports user-generated (server-owned profile.library_items) tracks into a
// SQLite `pending.db` and uploads it to S3, where the offline admin MCP
// (lectorium-mcp, the CONSUMER) fetches it to browse + approve the tracks.
//
// The SQLite schema below is a cross-service CONTRACT shared byte-for-byte with
// the consumer — do NOT change a column name, type, or the index without a
// coordinated change on the consumer side.
//
// The image ships FROM scratch and CGO-free, so this package uses the pure-Go
// modernc.org/sqlite driver (never mattn/go-sqlite3).
package pending

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go, CGO-free SQLite driver
)

// schemaSQL is the exact pending.db schema the consumer (lectorium-mcp #1248)
// reads. It MUST match byte-for-byte — it is the cross-service contract.
const schemaSQL = `
CREATE TABLE pending (
  track_id TEXT PRIMARY KEY,
  owner_id TEXT,
  title_raw TEXT, author_raw TEXT, location_raw TEXT, date_raw TEXT, references_raw TEXT,
  lang TEXT NOT NULL,
  transcript_path TEXT, audio_path TEXT,
  audio_duration_ms INTEGER, audio_size_bytes INTEGER,
  created_at TEXT, consumed_at TEXT
);
CREATE INDEX idx_pending_unconsumed ON pending(consumed_at, created_at);
`

// Row is one raw profile.library_items record (only the columns the export
// needs). Mapping into a pending row happens in WriteDB so the column mapping
// is unit-testable without Postgres.
type Row struct {
	OwnerID       string  // library_items.user_id
	TrackID       string  // library_items.track_id (guaranteed non-empty by the query)
	TitleRaw      *string // library_items.title_raw
	AuthorRaw     *string // library_items.author_raw
	LocationRaw   *string // library_items.location_raw
	DateRaw       *string // library_items.date_raw
	Lang          *string // library_items.lang
	LangHint      *string // library_items.lang_hint
	TranscriptKey *string // library_items.transcript_key
	AudioKey      *string // library_items.audio_key

	// DurationSec is library_items.duration, which the migration documents as
	// SECONDS. The consumer's column is audio_duration_ms, so WriteDB converts
	// seconds → milliseconds (×1000). This is the ONLY unit assumption in the
	// mapping; if library_items.duration ever changes unit, update convertMS.
	DurationSec *int
	AddedAt     *time.Time // library_items.added_at
}

// lang resolves the NOT NULL pending.lang: first non-empty of lang, lang_hint,
// then the "ru" default. Mirrors COALESCE(lang, lang_hint, 'ru').
func (r Row) lang() string {
	if r.Lang != nil && *r.Lang != "" {
		return *r.Lang
	}
	if r.LangHint != nil && *r.LangHint != "" {
		return *r.LangHint
	}
	return "ru"
}

// durationMS maps duration (seconds) → audio_duration_ms. NULL stays NULL.
func (r Row) durationMS() any {
	if r.DurationSec == nil {
		return nil
	}
	return int64(*r.DurationSec) * 1000
}

// createdAt renders added_at as RFC3339 (UTC), or "" when unset.
func (r Row) createdAt() string {
	if r.AddedAt == nil {
		return ""
	}
	return r.AddedAt.UTC().Format(time.RFC3339)
}

// nullStr binds an optional string as SQL NULL when nil.
func nullStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// WriteDB creates a fresh SQLite pending.db at path (overwriting any existing
// file) with the contract schema and one pending row per input Row.
//
// Mapping (library_items → pending):
//   - track_id        ← track_id (PK)
//   - owner_id        ← user_id
//   - title/author/location/date_raw ← passthrough
//   - references_raw  ← ""  (not stored server-side)
//   - lang            ← COALESCE(lang, lang_hint, 'ru')
//   - transcript_path ← transcript_key
//   - audio_path      ← audio_key
//   - audio_duration_ms ← duration × 1000 (duration is SECONDS; see Row.DurationSec)
//   - audio_size_bytes  ← NULL (not tracked yet)
//   - created_at      ← added_at as RFC3339
//   - consumed_at     ← ""  (the consumer stamps this on approval)
func WriteDB(path string, rows []Row) (err error) {
	// os.Remove semantics: sql.Open won't truncate an existing file, so callers
	// must hand us a fresh path. The producer always writes to a unique temp
	// file, and tests write to t.TempDir(); we still create a clean DB here.
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("open sqlite %s: %w", path, err)
	}
	defer func() {
		if cerr := db.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close sqlite %s: %w", path, cerr)
		}
	}()

	if _, err = db.Exec(schemaSQL); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	stmt, err := tx.Prepare(`
		INSERT INTO pending (
			track_id, owner_id,
			title_raw, author_raw, location_raw, date_raw, references_raw,
			lang,
			transcript_path, audio_path,
			audio_duration_ms, audio_size_bytes,
			created_at, consumed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, r := range rows {
		if _, err = stmt.Exec(
			r.TrackID, r.OwnerID,
			nullStr(r.TitleRaw), nullStr(r.AuthorRaw), nullStr(r.LocationRaw), nullStr(r.DateRaw), "",
			r.lang(),
			nullStr(r.TranscriptKey), nullStr(r.AudioKey),
			r.durationMS(), nil, // audio_size_bytes unknown → NULL
			r.createdAt(), "",
		); err != nil {
			return fmt.Errorf("insert track %q: %w", r.TrackID, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
