// Package sqlite implements port.MeetingRepository on an embedded SQLite
// database (pure-Go modernc.org/sqlite — no cgo, so it cross-compiles cleanly).
// The schema is versioned via SchemaVersion for forward migrations.
package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
	_ "modernc.org/sqlite"
)

// SchemaVersion is the on-disk schema version, stamped on every meeting so old
// rows can be migrated forward without guessing their shape.
const SchemaVersion = 1

const schema = `
CREATE TABLE IF NOT EXISTS meeting (
    id             TEXT PRIMARY KEY,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    provider       TEXT,
    languages      TEXT,   -- JSON array of language codes
    summary        TEXT,
    summary_model  TEXT,
    meta           TEXT,   -- JSON object
    schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS utterance (
    meeting_id TEXT NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    speaker    TEXT,
    text       TEXT NOT NULL,
    start_ms   INTEGER,
    end_ms     INTEGER,
    channel    INTEGER,
    confidence REAL,
    provider   TEXT,
    lang       TEXT,
    PRIMARY KEY (meeting_id, seq)
);
`

// Repo is a SQLite-backed meeting repository.
type Repo struct {
	db *sql.DB
}

var _ port.MeetingRepository = (*Repo)(nil)

// Open opens (creating if needed) the meetings database at the given path and
// applies the schema. An empty path defaults to $XDG_DATA_HOME/shruti/meetings.db.
func Open(path string) (*Repo, error) {
	if path == "" {
		var err error
		if path, err = defaultPath(); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("sqlite: create data dir: %w", err)
	}
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("sqlite: open: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: apply schema: %w", err)
	}
	return &Repo{db: db}, nil
}

// Close closes the database.
func (r *Repo) Close() error { return r.db.Close() }

func defaultPath() (string, error) {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "shruti", "meetings.db"), nil
}

// Save upserts a meeting and replaces its utterances atomically.
func (r *Repo) Save(ctx context.Context, m *domain.Meeting) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin: %w", err)
	}
	defer tx.Rollback()

	langs, _ := json.Marshal(m.Languages)
	meta, _ := json.Marshal(m.Meta)
	var summaryText, summaryModel any
	if m.Summary != nil {
		summaryText, summaryModel = m.Summary.Text, m.Summary.Model
	}
	_, err = tx.ExecContext(ctx, `
        INSERT INTO meeting (id, started_at, ended_at, provider, languages, summary, summary_model, meta, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            started_at=excluded.started_at, ended_at=excluded.ended_at, provider=excluded.provider,
            languages=excluded.languages, summary=excluded.summary, summary_model=excluded.summary_model,
            meta=excluded.meta, schema_version=excluded.schema_version`,
		string(m.ID), m.StartedAt.Format(time.RFC3339Nano), nullTime(m.EndedAt),
		string(m.Provider), string(langs), summaryText, summaryModel, string(meta), SchemaVersion)
	if err != nil {
		return fmt.Errorf("sqlite: upsert meeting: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM utterance WHERE meeting_id=?`, string(m.ID)); err != nil {
		return fmt.Errorf("sqlite: clear utterances: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx, `
        INSERT INTO utterance (meeting_id, seq, speaker, text, start_ms, end_ms, channel, confidence, provider, lang)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("sqlite: prepare utterance: %w", err)
	}
	defer stmt.Close()
	for i, u := range m.Utterances {
		if _, err := stmt.ExecContext(ctx, string(m.ID), i, u.Speaker, u.Text,
			u.Span.StartMs, u.Span.EndMs, u.Channel, u.Confidence, string(u.Provider), string(u.Lang)); err != nil {
			return fmt.Errorf("sqlite: insert utterance %d: %w", i, err)
		}
	}
	return tx.Commit()
}

// Get loads one meeting with its utterances.
func (r *Repo) Get(ctx context.Context, id domain.MeetingID) (*domain.Meeting, error) {
	row := r.db.QueryRowContext(ctx, `
        SELECT id, started_at, ended_at, provider, languages, summary, summary_model, meta
        FROM meeting WHERE id=?`, string(id))
	m, err := scanMeeting(row)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, `
        SELECT speaker, text, start_ms, end_ms, channel, confidence, provider, lang
        FROM utterance WHERE meeting_id=? ORDER BY seq`, string(id))
	if err != nil {
		return nil, fmt.Errorf("sqlite: query utterances: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var u domain.Utterance
		var provider, lang string
		if err := rows.Scan(&u.Speaker, &u.Text, &u.Span.StartMs, &u.Span.EndMs, &u.Channel, &u.Confidence, &provider, &lang); err != nil {
			return nil, fmt.Errorf("sqlite: scan utterance: %w", err)
		}
		u.Provider, u.Lang = domain.ProviderID(provider), domain.Language(lang)
		m.Utterances = append(m.Utterances, u)
	}
	return m, rows.Err()
}

// List returns all meetings (without utterances) newest-first.
func (r *Repo) List(ctx context.Context) ([]domain.Meeting, error) {
	rows, err := r.db.QueryContext(ctx, `
        SELECT id, started_at, ended_at, provider, languages, summary, summary_model, meta
        FROM meeting ORDER BY started_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("sqlite: list: %w", err)
	}
	defer rows.Close()
	var out []domain.Meeting
	for rows.Next() {
		m, err := scanMeeting(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// scanner abstracts *sql.Row and *sql.Rows for scanMeeting.
type scanner interface {
	Scan(dest ...any) error
}

func scanMeeting(s scanner) (*domain.Meeting, error) {
	var (
		m                          domain.Meeting
		id, provider               string
		startedAt                  string
		endedAt, summary, sumModel sql.NullString
		langsJSON, metaJSON        sql.NullString
	)
	if err := s.Scan(&id, &startedAt, &endedAt, &provider, &langsJSON, &summary, &sumModel, &metaJSON); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("sqlite: meeting not found")
		}
		return nil, fmt.Errorf("sqlite: scan meeting: %w", err)
	}
	m.ID = domain.MeetingID(id)
	m.Provider = domain.ProviderID(provider)
	m.StartedAt, _ = time.Parse(time.RFC3339Nano, startedAt)
	if endedAt.Valid {
		m.EndedAt, _ = time.Parse(time.RFC3339Nano, endedAt.String)
	}
	if langsJSON.Valid {
		_ = json.Unmarshal([]byte(langsJSON.String), &m.Languages)
	}
	if metaJSON.Valid {
		_ = json.Unmarshal([]byte(metaJSON.String), &m.Meta)
	}
	if summary.Valid && summary.String != "" {
		m.Summary = &domain.Summary{Text: summary.String, Model: sumModel.String}
	}
	return &m, nil
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Format(time.RFC3339Nano)
}
