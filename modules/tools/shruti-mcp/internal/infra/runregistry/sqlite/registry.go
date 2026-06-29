// Package sqliteregistry persists runregistry.Registry to a SQLite file
// (out/artifacts/lake/runs.db by default). Writes go straight to disk;
// hot-path reads (run.status during a long pipeline) hit an in-memory
// snapshot maintained as a write-through cache. Cancel hooks
// (context.CancelFunc) live in memory only — they can't be persisted, so
// post-restart runs in non-terminal state are reconciled to "failed" with
// error="daemon restart" on registry construction.
//
// `kind` is treated as opaque TEXT at the SQL boundary so dropping or
// renaming a run.Kind constant does not break loading historical rows
// (a row's kind value is just preserved verbatim).
package sqliteregistry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/ids/nanoid"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/runregistry"
)

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  selector_json TEXT,
  targets_json  TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_text   TEXT,
  error_text    TEXT NOT NULL DEFAULT '',
  cancellable   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_kind_state ON runs(kind, state);
`

// IDMinter mints run ids when the caller doesn't supply one. Defaults to
// nanoid; injectable for tests.
type IDMinter interface {
	MintTail() string
}

// Registry persists runs to SQLite with an in-memory cache for hot reads.
type Registry struct {
	db     *sql.DB
	minter IDMinter

	mu      sync.RWMutex
	cache   map[string]run.Run
	cancels map[string]context.CancelFunc
}

// New opens (or creates) the runs.db at path, runs migrations, and
// reconciles post-restart leftovers (any non-terminal row → failed with
// error="daemon restart"). Caller must Close.
func New(ctx context.Context, path string) (*Registry, error) {
	return NewWithMinter(ctx, path, nanoid.New())
}

// NewWithMinter is the test seam for deterministic ids.
func NewWithMinter(ctx context.Context, path string, minter IDMinter) (*Registry, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	dsn := "file:" + path + "?_journal=WAL&_busy_timeout=60000&_foreign_keys=on&_synchronous=NORMAL"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open runs.db: %w", err)
	}
	// Single connection: SQLite handles concurrent writes via WAL but the
	// caller serialization here is finer-grained; matches lakeregistry's
	// pattern.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := db.ExecContext(ctx, schema)
		return err
	}); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	r := &Registry{
		db:      db,
		minter:  minter,
		cache:   map[string]run.Run{},
		cancels: map[string]context.CancelFunc{},
	}

	if err := r.reconcileOnBoot(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("boot reconcile: %w", err)
	}
	if err := r.warmCache(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("warm cache: %w", err)
	}
	return r, nil
}

// Close releases the underlying SQLite handle.
func (r *Registry) Close() error { return r.db.Close() }

// reconcileOnBoot scans for non-terminal rows (queued / running) left over
// from a prior daemon process, marks them failed with a clear error
// string. We do NOT auto-resume — external services (whisper, gemini, S3
// publish) have their own state and a blind retry is unsafe.
func (r *Registry) reconcileOnBoot(ctx context.Context) error {
	now := time.Now().UTC().Format(time.RFC3339)
	const stmt = `
UPDATE runs
SET state = ?, finished_at = ?, error_text = ?
WHERE state IN (?, ?)`
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx, stmt,
			string(run.StateFailed), now, "daemon restart",
			string(run.StateQueued), string(run.StateRunning),
		)
		return err
	})
}

// warmCache loads every persisted row into the in-memory cache so reads
// (run.status, runs.list) don't have to hit SQLite during normal operation.
// Cache stays in sync via every Submit/Update path also updating it.
func (r *Registry) warmCache(ctx context.Context) error {
	const stmt = `
SELECT id, kind, state, started_at, finished_at,
       selector_json, targets_json, progress_json, result_text,
       error_text, cancellable
FROM runs`
	rows, err := r.db.QueryContext(ctx, stmt)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		rec, err := scanRun(rows)
		if err != nil {
			return err
		}
		r.cache[rec.Id] = rec
	}
	return rows.Err()
}

func (r *Registry) Submit(ctx context.Context, in run.Run) (run.Run, error) {
	if in.Id == "" {
		in.Id = "run_" + r.minter.MintTail()
	}
	if in.State == "" {
		in.State = run.StateQueued
	}
	if in.StartedAt.IsZero() {
		in.StartedAt = time.Now().UTC()
	}
	if err := r.upsert(ctx, in); err != nil {
		return run.Run{}, err
	}
	r.mu.Lock()
	r.cache[in.Id] = in
	r.mu.Unlock()
	return in, nil
}

func (r *Registry) Get(_ context.Context, id string) (run.Run, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	v, ok := r.cache[id]
	if !ok {
		return run.Run{}, runregistry.ErrNotFound
	}
	return v, nil
}

func (r *Registry) Update(ctx context.Context, in run.Run) error {
	r.mu.Lock()
	prev, ok := r.cache[in.Id]
	if !ok {
		r.mu.Unlock()
		return runregistry.ErrNotFound
	}
	if prev.State.IsTerminal() {
		r.mu.Unlock()
		return runregistry.ErrTerminal
	}
	r.mu.Unlock()

	if err := r.upsert(ctx, in); err != nil {
		return err
	}
	r.mu.Lock()
	r.cache[in.Id] = in
	if in.State.IsTerminal() {
		delete(r.cancels, in.Id)
	}
	r.mu.Unlock()
	return nil
}

func (r *Registry) List(_ context.Context, opts runregistry.ListOptions) ([]run.Run, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = runregistry.DefaultListLimit
	}

	r.mu.RLock()
	all := make([]run.Run, 0, len(r.cache))
	for _, v := range r.cache {
		if opts.Kind != "" && v.Kind != opts.Kind {
			continue
		}
		if opts.State != "" && v.State != opts.State {
			continue
		}
		all = append(all, v)
	}
	r.mu.RUnlock()

	// Order: most-recently-started first. Stable on equal timestamps.
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].StartedAt.After(all[j].StartedAt)
	})

	if opts.State == "" {
		// Default "active + recent": prefer non-terminal first, then fill
		// with the most recent terminals up to the limit.
		var active, terminal []run.Run
		for _, v := range all {
			if v.State.IsTerminal() {
				terminal = append(terminal, v)
			} else {
				active = append(active, v)
			}
		}
		all = append(active, terminal...)
	}
	if len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}

func (r *Registry) Cancel(ctx context.Context, id string) error {
	r.mu.Lock()
	prev, ok := r.cache[id]
	if !ok {
		r.mu.Unlock()
		return runregistry.ErrNotFound
	}
	if prev.State.IsTerminal() {
		r.mu.Unlock()
		return nil // idempotent
	}
	cancel := r.cancels[id]
	delete(r.cancels, id)

	next, err := prev.Transition(run.StateCancelled)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	next.Error = "cancelled"
	r.cache[id] = next
	r.mu.Unlock()

	if err := r.upsert(ctx, next); err != nil {
		return err
	}
	if cancel != nil {
		cancel()
	}
	return nil
}

func (r *Registry) SetCancelFunc(id string, cancel context.CancelFunc) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.cache[id]; !ok {
		return runregistry.ErrNotFound
	}
	r.cancels[id] = cancel
	return nil
}

// upsert writes the run row to SQLite. Called by Submit / Update / Cancel.
func (r *Registry) upsert(ctx context.Context, rec run.Run) error {
	selJSON, err := marshalSelector(rec.Selector)
	if err != nil {
		return fmt.Errorf("selector: %w", err)
	}
	targets := jsonOrNull(rec.Targets)
	progress, err := json.Marshal(rec.Progress)
	if err != nil {
		return fmt.Errorf("progress: %w", err)
	}
	var resultText sql.NullString
	if len(rec.Result) > 0 {
		resultText = sql.NullString{String: string(rec.Result), Valid: true}
	}
	var finishedAt sql.NullString
	if !rec.FinishedAt.IsZero() {
		finishedAt = sql.NullString{String: rec.FinishedAt.UTC().Format(time.RFC3339Nano), Valid: true}
	}
	cancellable := 0
	if rec.Cancellable {
		cancellable = 1
	}
	const stmt = `
INSERT INTO runs (id, kind, state, started_at, finished_at,
                  selector_json, targets_json, progress_json, result_text,
                  error_text, cancellable)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  state = excluded.state,
  started_at = excluded.started_at,
  finished_at = excluded.finished_at,
  selector_json = excluded.selector_json,
  targets_json = excluded.targets_json,
  progress_json = excluded.progress_json,
  result_text = excluded.result_text,
  error_text = excluded.error_text,
  cancellable = excluded.cancellable`
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx, stmt,
			rec.Id,
			string(rec.Kind),
			string(rec.State),
			rec.StartedAt.UTC().Format(time.RFC3339Nano),
			finishedAt,
			selJSON,
			targets,
			string(progress),
			resultText,
			rec.Error,
			cancellable,
		)
		return err
	})
}

// scanRun reads one run row from a *sql.Rows / *sql.Row.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanRun(s rowScanner) (run.Run, error) {
	var (
		rec        run.Run
		startedAt  string
		finishedAt sql.NullString
		selJSON    sql.NullString
		targets    sql.NullString
		progress   string
		resultText sql.NullString
		cancel     int
	)
	err := s.Scan(
		&rec.Id, &rec.Kind, &rec.State,
		&startedAt, &finishedAt,
		&selJSON, &targets, &progress, &resultText,
		&rec.Error, &cancel,
	)
	if err != nil {
		return run.Run{}, err
	}
	if t, terr := time.Parse(time.RFC3339Nano, startedAt); terr == nil {
		rec.StartedAt = t
	}
	if finishedAt.Valid {
		if t, terr := time.Parse(time.RFC3339Nano, finishedAt.String); terr == nil {
			rec.FinishedAt = t
		}
	}
	if selJSON.Valid && selJSON.String != "" {
		var sel track.Selector
		if jerr := json.Unmarshal([]byte(selJSON.String), &sel); jerr == nil {
			rec.Selector = &sel
		}
	}
	if targets.Valid && targets.String != "" {
		_ = json.Unmarshal([]byte(targets.String), &rec.Targets)
	}
	if progress != "" {
		_ = json.Unmarshal([]byte(progress), &rec.Progress)
	}
	if resultText.Valid {
		rec.Result = json.RawMessage(resultText.String)
	}
	if cancel != 0 {
		rec.Cancellable = true
	}
	return rec, nil
}

// marshalSelector returns NULL when the selector is nil, otherwise its JSON.
func marshalSelector(s *track.Selector) (sql.NullString, error) {
	if s == nil {
		return sql.NullString{}, nil
	}
	body, err := json.Marshal(s)
	if err != nil {
		return sql.NullString{}, err
	}
	return sql.NullString{String: string(body), Valid: true}, nil
}

func jsonOrNull(targets []string) sql.NullString {
	if len(targets) == 0 {
		return sql.NullString{}
	}
	body, err := json.Marshal(targets)
	if err != nil {
		return sql.NullString{}
	}
	return sql.NullString{String: string(body), Valid: true}
}

// Compile-time check.
var _ runregistry.Registry = (*Registry)(nil)

// errBoot satisfies stdlib `errors.Is` if anyone wants to test for the
// reconciliation marker. Currently unused — provided for future hooks.
var errBoot = errors.New("daemon restart")
