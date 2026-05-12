// Package store wraps the SQLite-backed job persistence.
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"github.com/akdasa-studios/lectorium/modules/tools/transcriber-service/internal/job"
)

const schema = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  language TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
  uploaded_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  duration_seconds REAL,
  processing_time_seconds REAL,
  rtfx REAL,
  confidence REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, uploaded_at);
`

// Store is a thin SQLite wrapper. Safe for concurrent use (SQLite serializes writes).
type Store struct {
	db *sql.DB
}

// Open opens (and migrates) the SQLite database at path.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Insert creates a new queued job.
func (s *Store) Insert(j *job.Job) error {
	_, err := s.db.Exec(
		`INSERT INTO jobs (job_id, filename, language, status, uploaded_at)
		 VALUES (?, ?, ?, ?, ?)`,
		j.JobID, j.Filename, nullStr(j.Language), j.Status, j.UploadedAt,
	)
	return err
}

// MarkRunning transitions a job to running.
func (s *Store) MarkRunning(jobID string) error {
	_, err := s.db.Exec(
		`UPDATE jobs SET status='running', started_at=? WHERE job_id=? AND status IN ('queued','running')`,
		time.Now().UnixMilli(), jobID,
	)
	return err
}

// MarkDone transitions a job to done with the final metrics.
func (s *Store) MarkDone(jobID string, m job.Metrics) error {
	_, err := s.db.Exec(
		`UPDATE jobs
		 SET status='done', completed_at=?,
		     processing_time_seconds=?, duration_seconds=?, confidence=?, rtfx=?
		 WHERE job_id=?`,
		time.Now().UnixMilli(),
		m.ProcessingTimeSeconds, m.DurationSeconds, m.Confidence, m.RTFx,
		jobID,
	)
	return err
}

// MarkFailed transitions a job to failed.
func (s *Store) MarkFailed(jobID, errMsg string) error {
	_, err := s.db.Exec(
		`UPDATE jobs SET status='failed', completed_at=?, error=? WHERE job_id=?`,
		time.Now().UnixMilli(), errMsg, jobID,
	)
	return err
}

// ResetRunningToQueued is called at startup: any job in 'running' got there from
// a previous process that crashed mid-inference, so put it back in the queue.
func (s *Store) ResetRunningToQueued() (int, error) {
	res, err := s.db.Exec(
		`UPDATE jobs SET status='queued', started_at=NULL WHERE status='running'`,
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// QueuedJobIDs returns the IDs of jobs currently in 'queued' state, oldest first.
// Used at startup to refeed pending work into fluidbatchd.
func (s *Store) QueuedJobIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT job_id FROM jobs WHERE status='queued' ORDER BY uploaded_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// Get fetches one job by id. Returns nil, nil if not found.
func (s *Store) Get(jobID string) (*job.Job, error) {
	row := s.db.QueryRow(`
		SELECT job_id, filename, language, status, uploaded_at,
		       started_at, completed_at,
		       duration_seconds, processing_time_seconds, rtfx, confidence, error
		FROM jobs WHERE job_id=?`, jobID)
	return scanJob(row)
}

// List returns jobs filtered by status (empty = all), most recent first.
func (s *Store) List(status string, limit int) ([]*job.Job, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	var rows *sql.Rows
	var err error
	q := `SELECT job_id, filename, language, status, uploaded_at,
	             started_at, completed_at,
	             duration_seconds, processing_time_seconds, rtfx, confidence, error
	      FROM jobs`
	if status != "" {
		q += ` WHERE status=? ORDER BY uploaded_at DESC LIMIT ?`
		rows, err = s.db.Query(q, status, limit)
	} else {
		q += ` ORDER BY uploaded_at DESC LIMIT ?`
		rows, err = s.db.Query(q, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []*job.Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// Delete removes a job row. Caller is responsible for files.
func (s *Store) Delete(jobID string) error {
	_, err := s.db.Exec(`DELETE FROM jobs WHERE job_id=?`, jobID)
	return err
}

// Counts returns aggregate counts per status (for /healthz).
func (s *Store) Counts() (queued, running, done, failed int, err error) {
	rows, err := s.db.Query(`SELECT status, COUNT(*) FROM jobs GROUP BY status`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			return 0, 0, 0, 0, err
		}
		switch st {
		case "queued":
			queued = n
		case "running":
			running = n
		case "done":
			done = n
		case "failed":
			failed = n
		}
	}
	return queued, running, done, failed, rows.Err()
}

// --- helpers ---

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(r rowScanner) (*job.Job, error) {
	var (
		j        job.Job
		lang     sql.NullString
		started  sql.NullInt64
		complete sql.NullInt64
		dur      sql.NullFloat64
		proc     sql.NullFloat64
		rtfx     sql.NullFloat64
		conf     sql.NullFloat64
		errMsg   sql.NullString
		status   string
	)
	err := r.Scan(
		&j.JobID, &j.Filename, &lang, &status, &j.UploadedAt,
		&started, &complete, &dur, &proc, &rtfx, &conf, &errMsg,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	j.Status = job.Status(status)
	if lang.Valid {
		j.Language = lang.String
	}
	if started.Valid {
		j.StartedAt = started.Int64
	}
	if complete.Valid {
		j.CompletedAt = complete.Int64
	}
	if dur.Valid {
		j.DurationSeconds = dur.Float64
	}
	if proc.Valid {
		j.ProcessingTimeSeconds = proc.Float64
	}
	if rtfx.Valid {
		j.RTFx = rtfx.Float64
	}
	if conf.Valid {
		j.Confidence = conf.Float64
	}
	if errMsg.Valid {
		j.Error = errMsg.String
	}
	return &j, nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
