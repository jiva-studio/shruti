package pending

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func ptr[T any](v T) *T { return &v }

// openReadback opens the just-written pending.db for assertions.
func openReadback(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatalf("open readback: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// TestWriteDBSchema asserts the produced file carries the exact contract
// schema: the pending table columns (name + declared type + NOT NULL on lang)
// and the idx_pending_unconsumed index. This is the cross-service contract with
// the consumer, so it must not drift. No Postgres needed.
func TestWriteDBSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pending.db")
	if err := WriteDB(path, nil); err != nil {
		t.Fatalf("WriteDB: %v", err)
	}
	db := openReadback(t, path)

	wantCols := []struct {
		name    string
		typ     string
		notNull bool
	}{
		{"track_id", "TEXT", false}, // PK but SQLite reports notnull=0 for TEXT PK
		{"owner_id", "TEXT", false},
		{"title_raw", "TEXT", false},
		{"author_raw", "TEXT", false},
		{"location_raw", "TEXT", false},
		{"date_raw", "TEXT", false},
		{"references_raw", "TEXT", false},
		{"lang", "TEXT", true},
		{"transcript_path", "TEXT", false},
		{"audio_path", "TEXT", false},
		{"audio_duration_ms", "INTEGER", false},
		{"audio_size_bytes", "INTEGER", false},
		{"created_at", "TEXT", false},
		{"consumed_at", "TEXT", false},
	}

	rows, err := db.Query(`PRAGMA table_info(pending)`)
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close()

	type colInfo struct {
		typ     string
		notNull bool
		pk      int
	}
	got := map[string]colInfo{}
	var order []string
	for rows.Next() {
		var (
			cid       int
			name, typ string
			notNull   int
			dflt      sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		got[name] = colInfo{typ: typ, notNull: notNull == 1, pk: pk}
		order = append(order, name)
	}
	if len(order) != len(wantCols) {
		t.Fatalf("column count = %d, want %d (%v)", len(order), len(wantCols), order)
	}
	for i, w := range wantCols {
		if order[i] != w.name {
			t.Errorf("column %d = %q, want %q", i, order[i], w.name)
		}
		ci, ok := got[w.name]
		if !ok {
			t.Errorf("missing column %q", w.name)
			continue
		}
		if ci.typ != w.typ {
			t.Errorf("column %q type = %q, want %q", w.name, ci.typ, w.typ)
		}
		if ci.notNull != w.notNull {
			t.Errorf("column %q notNull = %v, want %v", w.name, ci.notNull, w.notNull)
		}
	}
	if got["track_id"].pk != 1 {
		t.Errorf("track_id pk = %d, want 1", got["track_id"].pk)
	}

	// Index presence.
	var idxName string
	if err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_unconsumed'`,
	).Scan(&idxName); err != nil {
		t.Fatalf("index idx_pending_unconsumed missing: %v", err)
	}
}

// TestWriteDBMapping asserts the library_items → pending column mapping,
// especially owner_id←user_id, the lang COALESCE fallback, path columns, the
// seconds→milliseconds duration conversion, and the empty references_raw /
// consumed_at contract values.
func TestWriteDBMapping(t *testing.T) {
	added := time.Date(2026, 7, 18, 9, 30, 0, 0, time.UTC)
	rows := []Row{
		{
			OwnerID:       "user-1",
			TrackID:       "track-1",
			TitleRaw:      ptr("A Talk"),
			AuthorRaw:     ptr("Some Author"),
			LocationRaw:   ptr("Vrindavan"),
			DateRaw:       ptr("1975"),
			Lang:          ptr("en"),
			LangHint:      ptr("ru"),
			TranscriptKey: ptr("transcripts/track-1.json"),
			AudioKey:      ptr("audio/track-1.mp3"),
			DurationSec:   ptr(125),
			AddedAt:       &added,
		},
		{
			// lang nil, lang_hint set → falls back to lang_hint.
			OwnerID:  "user-2",
			TrackID:  "track-2",
			LangHint: ptr("hi"),
		},
		{
			// lang + lang_hint both nil → "ru"; duration/paths NULL.
			OwnerID: "user-3",
			TrackID: "track-3",
		},
	}
	path := filepath.Join(t.TempDir(), "pending.db")
	if err := WriteDB(path, rows); err != nil {
		t.Fatalf("WriteDB: %v", err)
	}
	db := openReadback(t, path)

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 {
		t.Fatalf("row count = %d, want 3", n)
	}

	// Row 1: full mapping.
	var (
		owner, lang                    string
		title, author, loc, date, refs sql.NullString
		transcriptPath, audioPath      sql.NullString
		durationMS, sizeBytes          sql.NullInt64
		createdAt, consumedAt          sql.NullString
	)
	err := db.QueryRow(`
		SELECT owner_id, title_raw, author_raw, location_raw, date_raw, references_raw,
		       lang, transcript_path, audio_path, audio_duration_ms, audio_size_bytes,
		       created_at, consumed_at
		  FROM pending WHERE track_id = 'track-1'`).Scan(
		&owner, &title, &author, &loc, &date, &refs,
		&lang, &transcriptPath, &audioPath, &durationMS, &sizeBytes,
		&createdAt, &consumedAt,
	)
	if err != nil {
		t.Fatalf("select track-1: %v", err)
	}
	if owner != "user-1" {
		t.Errorf("owner_id = %q, want user-1 (from user_id)", owner)
	}
	if lang != "en" {
		t.Errorf("lang = %q, want en", lang)
	}
	if title.String != "A Talk" || author.String != "Some Author" || loc.String != "Vrindavan" || date.String != "1975" {
		t.Errorf("raw passthrough wrong: %q/%q/%q/%q", title.String, author.String, loc.String, date.String)
	}
	if !refs.Valid || refs.String != "" {
		t.Errorf("references_raw = %v/%q, want empty string", refs.Valid, refs.String)
	}
	if transcriptPath.String != "transcripts/track-1.json" {
		t.Errorf("transcript_path = %q, want transcript_key value", transcriptPath.String)
	}
	if audioPath.String != "audio/track-1.mp3" {
		t.Errorf("audio_path = %q, want audio_key value", audioPath.String)
	}
	if !durationMS.Valid || durationMS.Int64 != 125_000 {
		t.Errorf("audio_duration_ms = %v/%d, want 125000 (125s×1000)", durationMS.Valid, durationMS.Int64)
	}
	if sizeBytes.Valid {
		t.Errorf("audio_size_bytes = %d, want NULL", sizeBytes.Int64)
	}
	if createdAt.String != "2026-07-18T09:30:00Z" {
		t.Errorf("created_at = %q, want RFC3339 of added_at", createdAt.String)
	}
	if !consumedAt.Valid || consumedAt.String != "" {
		t.Errorf("consumed_at = %v/%q, want empty string", consumedAt.Valid, consumedAt.String)
	}

	// Row 2: lang fallback to lang_hint.
	if err := db.QueryRow(`SELECT lang FROM pending WHERE track_id = 'track-2'`).Scan(&lang); err != nil {
		t.Fatalf("select track-2: %v", err)
	}
	if lang != "hi" {
		t.Errorf("track-2 lang = %q, want hi (lang_hint fallback)", lang)
	}

	// Row 3: lang default; NULL duration + paths.
	if err := db.QueryRow(`
		SELECT lang, audio_duration_ms, transcript_path, audio_path, created_at
		  FROM pending WHERE track_id = 'track-3'`).Scan(
		&lang, &durationMS, &transcriptPath, &audioPath, &createdAt,
	); err != nil {
		t.Fatalf("select track-3: %v", err)
	}
	if lang != "ru" {
		t.Errorf("track-3 lang = %q, want ru (default)", lang)
	}
	if durationMS.Valid {
		t.Errorf("track-3 audio_duration_ms = %d, want NULL", durationMS.Int64)
	}
	if transcriptPath.Valid || audioPath.Valid {
		t.Errorf("track-3 paths should be NULL, got %q/%q", transcriptPath.String, audioPath.String)
	}
	if createdAt.String != "" {
		t.Errorf("track-3 created_at = %q, want empty (added_at nil)", createdAt.String)
	}
}
