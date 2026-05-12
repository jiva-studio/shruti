package sqliteregistry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/lakeregistry/sqlite/migrations"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/sqliteutil"
	lakeport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
)

// Registry implements lakeport.Registry on top of an embedded SQLite (WAL mode).
type Registry struct {
	db     *sql.DB
	minter Minter

	processStart time.Time // claim stages with started_at < this as stale (prior crashed run)

	mu     sync.Mutex
	tracks map[track.Id]*sync.Mutex // per-track in-process lock
}

// Minter is the dependency for new track ids. Defined here to avoid a cycle
// with internal/ports/ids — we accept any 12-char tail producer.
type Minter interface {
	MintTail() string
}

// New opens (or creates) the index.db at path, runs migrations, and returns
// a ready Registry. Caller must Close().
func New(ctx context.Context, path string, minter Minter) (*Registry, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	// busy_timeout=60s: under 4-worker pool the single connection
	// (SetMaxOpenConns(1) below) serializes every SetStage/TryClaimStage
	// across pipeline stages. 5s was tight — batches of 1000 saw ~33%
	// SQLITE_BUSY rejections. 60s gives the queue room while the retry
	// wrapper (sqliteutil.WithRetry) handles whatever still slips through.
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=60000&_foreign_keys=on", path)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // single writer; reads are still OK because all stmts run via this DB
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	if err := applyMigrations(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Truncate to second precision (matching RFC3339 stored timestamps) and
	// give a 1-second cushion so claims written in the same second as startup
	// aren't mis-classified as stale.
	pStart := time.Now().UTC().Truncate(time.Second).Add(-time.Second)
	return &Registry{db: db, minter: minter, processStart: pStart, tracks: map[track.Id]*sync.Mutex{}}, nil
}

func (r *Registry) Close() error { return r.db.Close() }

// DB exposes the shared *sql.DB so sibling adapters in this package
// (e.g. TrackSelector) can run queries against the same connection
// pool. Not part of the public lakeport.Registry contract — only
// concrete sqliteregistry consumers reach for it.
func (r *Registry) DB() *sql.DB { return r.db }

func applyMigrations(ctx context.Context, db *sql.DB) error {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	var sqlFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			sqlFiles = append(sqlFiles, e.Name())
		}
	}
	sort.Strings(sqlFiles)
	for _, name := range sqlFiles {
		raw, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		if _, err := db.ExecContext(ctx, string(raw)); err != nil {
			// Migrations are bundled and re-run on every startup. SQLite
			// has no "ALTER TABLE ... ADD COLUMN IF NOT EXISTS", so an
			// already-applied 002 raises "duplicate column name". Treat
			// that (and the symmetric "no such column" on dropped fields)
			// as benign idempotency, not a crash.
			msg := err.Error()
			if strings.Contains(msg, "duplicate column name") || strings.Contains(msg, "no such column") {
				continue
			}
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	return nil
}

// TrackLock returns the per-track mutex for the given id (creates lazily).
// Callers should defer Unlock immediately after Lock.
func (r *Registry) TrackLock(id track.Id) *sync.Mutex {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.tracks[id]
	if !ok {
		m = &sync.Mutex{}
		r.tracks[id] = m
	}
	return m
}

// --- lakeport.Registry ---

func (r *Registry) UpsertFile(ctx context.Context, src track.SourceFile) (track.Id, bool, error) {
	if src.Path == "" {
		return "", false, errors.New("UpsertFile: empty path")
	}
	var (
		outID      track.Id
		outChanged bool
	)
	err := sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		id, changed, err := r.upsertFileOnce(ctx, src)
		if err != nil {
			return err
		}
		outID = id
		outChanged = changed
		return nil
	})
	return outID, outChanged, err
}

func (r *Registry) upsertFileOnce(ctx context.Context, src track.SourceFile) (track.Id, bool, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()

	var existingID, existingSHA string
	row := tx.QueryRowContext(ctx, `SELECT track_id, sha256 FROM files WHERE path = ?`, src.Path)
	err = row.Scan(&existingID, &existingSHA)
	switch {
	case err == sql.ErrNoRows:
		newID := "track_" + r.minter.MintTail()
		_, err = tx.ExecContext(ctx,
			`INSERT INTO files (path, track_id, sha256, size_bytes, ingested_at, language) VALUES (?,?,?,?,?,?)`,
			src.Path, newID, src.SHA256, src.Size, time.Now().UTC().Format(time.RFC3339), src.Language)
		if err != nil {
			return "", false, fmt.Errorf("insert files: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return "", false, err
		}
		id, err := track.NewId(newID)
		return id, false, err
	case err != nil:
		return "", false, err
	default:
		// existing row
		changed := existingSHA != src.SHA256
		if changed {
			_, err = tx.ExecContext(ctx,
				`UPDATE files SET sha256 = ?, size_bytes = ?, ingested_at = ? WHERE path = ?`,
				src.SHA256, src.Size, time.Now().UTC().Format(time.RFC3339), src.Path)
			if err != nil {
				return "", false, fmt.Errorf("update files: %w", err)
			}
		}
		// Backfill language if the row predates v2 or the caller now knows
		// it. Never overwrites a non-empty value with empty.
		if src.Language != "" {
			_, err = tx.ExecContext(ctx,
				`UPDATE files SET language = ? WHERE path = ? AND (language = '' OR language IS NULL)`,
				src.Language, src.Path)
			if err != nil {
				return "", false, fmt.Errorf("update files language: %w", err)
			}
		}
		if err := tx.Commit(); err != nil {
			return "", false, err
		}
		id, err := track.NewId(existingID)
		return id, changed, err
	}
}

func (r *Registry) LookupByPath(ctx context.Context, path string) (track.Id, bool, error) {
	row := r.db.QueryRowContext(ctx, `SELECT track_id FROM files WHERE path = ?`, path)
	var s string
	if err := row.Scan(&s); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	id, err := track.NewId(s)
	return id, true, err
}

func (r *Registry) LookupLanguage(ctx context.Context, id track.Id) (string, error) {
	row := r.db.QueryRowContext(ctx, `SELECT language FROM files WHERE track_id = ?`, string(id))
	var lang string
	if err := row.Scan(&lang); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return lang, nil
}

func (r *Registry) LookupPathByID(ctx context.Context, id track.Id) (string, error) {
	row := r.db.QueryRowContext(ctx, `SELECT path FROM files WHERE track_id = ?`, string(id))
	var p string
	if err := row.Scan(&p); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return p, nil
}

func (r *Registry) SetStage(ctx context.Context, id track.Id, key pipeline.Key, status pipeline.Status, payload []byte, errMessage string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.setStageOnce(ctx, id, key, status, payload, errMessage)
	})
}

func (r *Registry) setStageOnce(ctx context.Context, id track.Id, key pipeline.Key, status pipeline.Status, payload []byte, errMessage string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)
	startedAt := sql.NullString{}
	finishedAt := sql.NullString{}
	switch status {
	case pipeline.StatusRunning:
		startedAt = sql.NullString{String: now, Valid: true}
	case pipeline.StatusDone, pipeline.StatusFailed:
		finishedAt = sql.NullString{String: now, Valid: true}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO stages (track_id, stage, variant, status, started_at, finished_at, error, payload_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(track_id, stage, variant) DO UPDATE SET
			status        = excluded.status,
			started_at    = COALESCE(excluded.started_at, stages.started_at),
			finished_at   = COALESCE(excluded.finished_at, stages.finished_at),
			error         = excluded.error,
			payload_json  = excluded.payload_json`,
		string(id), string(key.Stage), key.Variant, string(status),
		startedAt, finishedAt, nullableString(errMessage), payload)
	if err != nil {
		return fmt.Errorf("upsert stage: %w", err)
	}

	// Cascade to dependents only when transitioning to Done.
	if status == pipeline.StatusDone {
		if err := cascadeReset(ctx, tx, id, key); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func cascadeReset(ctx context.Context, tx *sql.Tx, id track.Id, key pipeline.Key) error {
	deps := pipeline.Dependents(key.Stage)
	for _, d := range deps {
		switch d.Variant {
		case "":
			// language-agnostic dependent
			if err := resetStage(ctx, tx, id, d.Stage, ""); err != nil {
				return err
			}
		case "<self>":
			// same-language carry-through (transcribe(L) → review(L)/commit(L))
			if err := resetStage(ctx, tx, id, d.Stage, key.Variant); err != nil {
				return err
			}
		case "*":
			// every existing variant of any earlier stage for this track
			variants, err := languagesForTrack(ctx, tx, id)
			if err != nil {
				return err
			}
			for _, v := range variants {
				if err := resetStage(ctx, tx, id, d.Stage, v); err != nil {
					return err
				}
			}
			// language-agnostic case (variant '') is already handled by other deps;
			// '*' implies per-language cascade.
		}
	}
	return nil
}

func languagesForTrack(ctx context.Context, tx *sql.Tx, id track.Id) ([]string, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT DISTINCT variant FROM stages WHERE track_id = ? AND variant <> ''`, string(id))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func resetStage(ctx context.Context, tx *sql.Tx, id track.Id, stage pipeline.Stage, variant string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO stages (track_id, stage, variant, status)
		VALUES (?, ?, ?, 'pending')
		ON CONFLICT(track_id, stage, variant) DO UPDATE SET
			status        = 'pending',
			started_at    = NULL,
			finished_at   = NULL,
			error         = NULL,
			payload_json  = NULL`,
		string(id), string(stage), variant)
	return err
}

func (r *Registry) GetStage(ctx context.Context, id track.Id, key pipeline.Key) (lakeport.StageRow, bool, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT stage, variant, status,
		       COALESCE(started_at,''), COALESCE(finished_at,''),
		       COALESCE(error,''), COALESCE(payload_json,'')
		FROM stages WHERE track_id = ? AND stage = ? AND variant = ?`,
		string(id), string(key.Stage), key.Variant)
	var sr lakeport.StageRow
	var stage, variant, status, started, finished, errMsg, payload string
	err := row.Scan(&stage, &variant, &status, &started, &finished, &errMsg, &payload)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lakeport.StageRow{}, false, nil
		}
		return sr, false, err
	}
	sr.TrackId = id
	sr.Key = pipeline.Key{Stage: pipeline.Stage(stage), Variant: variant}
	sr.Status = pipeline.Status(status)
	sr.StartedAt = started
	sr.FinishedAt = finished
	sr.Error = errMsg
	if payload != "" {
		sr.Payload = []byte(payload)
	}
	return sr, true, nil
}

func (r *Registry) ListAllStages(ctx context.Context, id track.Id) ([]lakeport.StageRow, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT stage, variant, status,
		       COALESCE(started_at,''), COALESCE(finished_at,''),
		       COALESCE(error,''), COALESCE(payload_json,'')
		FROM stages WHERE track_id = ? ORDER BY stage, variant`, string(id))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lakeport.StageRow
	for rows.Next() {
		var sr lakeport.StageRow
		var stage, variant, status, started, finished, errMsg, payload string
		if err := rows.Scan(&stage, &variant, &status, &started, &finished, &errMsg, &payload); err != nil {
			return nil, err
		}
		sr.TrackId = id
		sr.Key = pipeline.Key{Stage: pipeline.Stage(stage), Variant: variant}
		sr.Status = pipeline.Status(status)
		sr.StartedAt = started
		sr.FinishedAt = finished
		sr.Error = errMsg
		if payload != "" {
			sr.Payload = []byte(payload)
		}
		out = append(out, sr)
	}
	return out, rows.Err()
}

func (r *Registry) ListPending(ctx context.Context, stage pipeline.Stage) ([]lakeport.FileRow, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT f.path, f.track_id, f.sha256, f.size_bytes, f.ingested_at
		FROM files f
		JOIN stages s ON s.track_id = f.track_id
		WHERE s.stage = ? AND s.status IN ('pending','failed')
		GROUP BY f.path
		ORDER BY f.path`, string(stage))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lakeport.FileRow
	for rows.Next() {
		var path, idStr, sha, ingested string
		var size int64
		if err := rows.Scan(&path, &idStr, &sha, &size, &ingested); err != nil {
			return nil, err
		}
		id, err := track.NewId(idStr)
		if err != nil {
			return nil, err
		}
		out = append(out, lakeport.FileRow{
			Source: track.SourceFile{Path: path, SHA256: sha, Size: size},
			Id:     id,
		})
	}
	return out, rows.Err()
}

func (r *Registry) ResetStagesFor(ctx context.Context, id track.Id) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx, `
			UPDATE stages SET status = 'pending', started_at = NULL,
			                  finished_at = NULL, error = NULL, payload_json = NULL
			WHERE track_id = ?`, string(id))
		return err
	})
}

// ResetStageAndDependents wipes the named stage row + every stage in
// pipeline.Dependents(key.Stage) to Pending in a single transaction. The
// cascade rules match the on-Done behaviour (cascadeReset) so the
// resulting state is identical to "the named stage was just freshly
// transitioned to Done, and downstream cascade ran" — except the named
// stage itself is Pending instead of Done. Used by per-stage re-run flows
// that want to keep upstream artifacts intact.
func (r *Registry) ResetStageAndDependents(ctx context.Context, id track.Id, key pipeline.Key) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		tx, err := r.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback() //nolint:errcheck
		if err := resetStage(ctx, tx, id, key.Stage, key.Variant); err != nil {
			return fmt.Errorf("reset %s/%s: %w", key.Stage, key.Variant, err)
		}
		if err := cascadeReset(ctx, tx, id, key); err != nil {
			return fmt.Errorf("cascade reset: %w", err)
		}
		return tx.Commit()
	})
}

func (r *Registry) TryClaimStage(ctx context.Context, id track.Id, key pipeline.Key) (bool, error) {
	var claimed bool
	err := sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		c, err := r.tryClaimStageOnce(ctx, id, key)
		if err != nil {
			return err
		}
		claimed = c
		return nil
	})
	return claimed, err
}

func (r *Registry) tryClaimStageOnce(ctx context.Context, id track.Id, key pipeline.Key) (bool, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	row := tx.QueryRowContext(ctx,
		`SELECT status, COALESCE(started_at,'') FROM stages WHERE track_id = ? AND stage = ? AND variant = ?`,
		string(id), string(key.Stage), key.Variant)
	var status, startedAtStr string
	err = row.Scan(&status, &startedAtStr)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if status == string(pipeline.StatusRunning) {
		// Stale-running heuristic: a row left in 'running' from a previous
		// process (e.g. SIGKILL before SetStage(failed)) is reclaimable. Only
		// refuse when it was started by THIS process — that means a real
		// concurrent caller still holds it.
		startedAt, perr := time.Parse(time.RFC3339, startedAtStr)
		if perr == nil && !startedAt.Before(r.processStart) {
			return false, nil
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO stages (track_id, stage, variant, status, started_at)
		VALUES (?, ?, ?, 'running', ?)
		ON CONFLICT(track_id, stage, variant) DO UPDATE SET
			status     = 'running',
			started_at = excluded.started_at,
			error      = NULL`,
		string(id), string(key.Stage), key.Variant, now)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Registry) MarkInterruptedAsFailed(ctx context.Context) (int, error) {
	res, err := r.db.ExecContext(ctx, `
		UPDATE stages SET status = 'failed',
		                  error = 'interrupted before previous run finished',
		                  finished_at = ?
		WHERE status = 'running'`, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (r *Registry) Scan(ctx context.Context, limit int, cursor string) ([]lakeport.FileRow, string, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT path, track_id, sha256, size_bytes, ingested_at
		FROM files
		WHERE path > ?
		ORDER BY path
		LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []lakeport.FileRow
	for rows.Next() {
		var path, idStr, sha, ingested string
		var size int64
		if err := rows.Scan(&path, &idStr, &sha, &size, &ingested); err != nil {
			return nil, "", err
		}
		id, err := track.NewId(idStr)
		if err != nil {
			return nil, "", err
		}
		out = append(out, lakeport.FileRow{
			Source: track.SourceFile{Path: path, SHA256: sha, Size: size},
			Id:     id,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// Hydrate stages.
	for i := range out {
		stages, err := r.ListAllStages(ctx, out[i].Id)
		if err != nil {
			return nil, "", err
		}
		out[i].Stages = stages
	}

	nextCursor := ""
	if len(out) == limit {
		nextCursor = string(out[len(out)-1].Source.Path)
	}
	return out, nextCursor, nil
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// MarshalPayload is a tiny helper so use cases can stash arbitrary state in
// the stage payload column without each touching encoding/json directly.
func MarshalPayload(v any) []byte {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte(fmt.Sprintf(`{"_marshal_error":%q}`, err.Error()))
	}
	return raw
}
