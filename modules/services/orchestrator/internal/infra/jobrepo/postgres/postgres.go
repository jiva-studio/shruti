// Package postgres implements the orchestrator's persistence ports against its
// own Postgres: the JobRepository (source of truth) and the transactional-outbox
// EventBus.
//
// Both share one Tx type so a job write and its lifecycle event land in the same
// transaction (the outbox invariant): a relay later drains the outbox to the
// broker, so an event is published iff the job write committed.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
	"github.com/jiva-studio/lectorium/orchestrator/internal/ports"
)

// Repo is the pgx-backed JobRepository + EventBus.
type Repo struct {
	pool *pgxpool.Pool
}

// New builds a Repo over an existing pool.
func New(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Tx wraps a pgx.Tx so it can be passed as the opaque ports.Tx through the
// repository and the event bus.
type Tx struct{ tx pgx.Tx }

// querier is satisfied by both *pgxpool.Pool and pgx.Tx.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// q resolves the caller's Tx (or the pool when nil) to a querier.
func (r *Repo) q(t ports.Tx) querier {
	if pt, ok := t.(*Tx); ok && pt != nil {
		return pt.tx
	}
	return r.pool
}

// WithTx runs fn in a transaction, committing on success and rolling back on
// error (or panic).
func (r *Repo) WithTx(ctx context.Context, fn func(ports.Tx) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(&Tx{tx: tx}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) CreateTx(ctx context.Context, t ports.Tx, j *job.Job) error {
	return r.insert(ctx, r.q(t), j)
}
func (r *Repo) SaveTx(ctx context.Context, t ports.Tx, j *job.Job) error {
	return r.update(ctx, r.q(t), j)
}

func (r *Repo) insert(ctx context.Context, q querier, j *job.Job) error {
	_, err := q.Exec(ctx, `
		INSERT INTO orchestrator.jobs (id, kind, owner_id, state, spec, result, track_id, error, attempts)
		VALUES ($1,$2,$3,$4,COALESCE($5::jsonb,'{}'::jsonb),$6::jsonb,$7,$8,$9)`,
		j.ID, string(j.Kind), nullUUID(j.OwnerID), string(j.State),
		jsonbOrNil(j.Spec), jsonbOrNil(j.Result), nullStr(j.TrackID), nullStr(j.Err), j.Attempts,
	)
	return err
}

func (r *Repo) update(ctx context.Context, q querier, j *job.Job) error {
	_, err := q.Exec(ctx, `
		UPDATE orchestrator.jobs
		   SET state=$2, result=$3::jsonb, track_id=$4, error=$5, attempts=$6, updated_at=now()
		 WHERE id=$1`,
		j.ID, string(j.State), jsonbOrNil(j.Result), nullStr(j.TrackID), nullStr(j.Err), j.Attempts,
	)
	return err
}

// Get loads a job by id; returns (nil, nil) when absent.
func (r *Repo) Get(ctx context.Context, id string) (*job.Job, error) {
	var (
		j        job.Job
		kind     string
		state    string
		owner    *string
		trackID  *string
		errStr   *string
		spec     []byte
		result   []byte
	)
	err := r.pool.QueryRow(ctx, `
		SELECT id, kind, owner_id::text, state, spec, result, track_id, error, attempts, created_at, updated_at
		  FROM orchestrator.jobs WHERE id=$1`, id).
		Scan(&j.ID, &kind, &owner, &state, &spec, &result, &trackID, &errStr, &j.Attempts, &j.CreatedAt, &j.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	j.Kind = job.Kind(kind)
	j.State = job.State(state)
	j.Spec = spec
	j.Result = result
	j.OwnerID = deref(owner)
	j.TrackID = deref(trackID)
	j.Err = deref(errStr)
	return &j, nil
}

// Publish implements ports.EventBus: it appends an event to the outbox in the
// caller's transaction (the same tx as the job write).
func (r *Repo) Publish(ctx context.Context, t ports.Tx, topic string, payload []byte) error {
	_, err := r.q(t).Exec(ctx,
		`INSERT INTO orchestrator.outbox (topic, payload) VALUES ($1, $2::jsonb)`,
		topic, string(payload))
	return err
}

// --- Outbox drain (used by the redisstream relay) ---

// OutboxRow is one unpublished outbox entry.
type OutboxRow struct {
	Seq     int64
	Topic   string
	Payload []byte
}

// FetchUnpublished returns up to limit unpublished outbox rows in seq order.
func (r *Repo) FetchUnpublished(ctx context.Context, limit int) ([]OutboxRow, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT seq, topic, payload FROM orchestrator.outbox
		  WHERE published_at IS NULL ORDER BY seq LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxRow
	for rows.Next() {
		var row OutboxRow
		if err := rows.Scan(&row.Seq, &row.Topic, &row.Payload); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// MarkPublished stamps published_at on a drained outbox row.
func (r *Repo) MarkPublished(ctx context.Context, seq int64) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE orchestrator.outbox SET published_at=now() WHERE seq=$1`, seq)
	return err
}

// --- helpers ---

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func jsonbOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
