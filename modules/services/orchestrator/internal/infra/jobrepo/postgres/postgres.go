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
	"time"

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
		INSERT INTO orchestrator.jobs (id, kind, op, membership_id, owner_id, state, spec, result, track_id, error, attempts, generation)
		VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::jsonb,'{}'::jsonb),$8::jsonb,$9,$10,$11,$12)`,
		j.ID, string(j.Kind), j.Op, nullStr(j.MembershipID), nullUUID(j.OwnerID), string(j.State),
		jsonbOrNil(j.Spec), jsonbOrNil(j.Result), nullStr(j.TrackID), nullStr(j.Err), j.Attempts, j.Generation,
	)
	return err
}

func (r *Repo) update(ctx context.Context, q querier, j *job.Job) error {
	_, err := q.Exec(ctx, `
		UPDATE orchestrator.jobs
		   SET state=$2, result=$3::jsonb, track_id=$4, error=$5, attempts=$6, generation=$7, updated_at=now()
		 WHERE id=$1`,
		j.ID, string(j.State), jsonbOrNil(j.Result), nullStr(j.TrackID), nullStr(j.Err), j.Attempts, j.Generation,
	)
	return err
}

// Get loads a job by id; returns (nil, nil) when absent.
func (r *Repo) Get(ctx context.Context, id string) (*job.Job, error) {
	return getJob(ctx, r.pool, id, "")
}

// GetForUpdateTx loads a job by id inside the caller's transaction, taking a row
// lock (SELECT … FOR UPDATE). Two consumers processing the same result serialize
// on this lock, so the retry decision (re-check attempt, increment, re-dispatch)
// happens exactly once even under concurrent redelivery.
func (r *Repo) GetForUpdateTx(ctx context.Context, t ports.Tx, id string) (*job.Job, error) {
	return getJob(ctx, r.q(t), id, " FOR UPDATE")
}

func getJob(ctx context.Context, q querier, id, lock string) (*job.Job, error) {
	var (
		j        job.Job
		kind     string
		op       string
		membID   *string
		state    string
		owner    *string
		trackID  *string
		errStr   *string
		spec     []byte
		result   []byte
		progress []byte
	)
	err := q.QueryRow(ctx, `
		SELECT id, kind, op, membership_id, owner_id::text, state, spec, result, progress, track_id, error, attempts, generation, created_at, updated_at
		  FROM orchestrator.jobs WHERE id=$1`+lock, id).
		Scan(&j.ID, &kind, &op, &membID, &owner, &state, &spec, &result, &progress, &trackID, &errStr, &j.Attempts, &j.Generation, &j.CreatedAt, &j.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	j.Kind = job.Kind(kind)
	j.Op = op
	j.MembershipID = deref(membID)
	j.State = job.State(state)
	j.Spec = spec
	j.Result = result
	j.Progress = progress
	j.OwnerID = deref(owner)
	j.TrackID = deref(trackID)
	j.Err = deref(errStr)
	return &j, nil
}

// UpdateProgress writes only the job's progress blob — a lightweight,
// off-the-hot-path update for the frequent per-stage heartbeats, so it never
// contends with the state/attempt writes. Best-effort at the call site.
func (r *Repo) UpdateProgress(ctx context.Context, id string, progress []byte) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE orchestrator.jobs SET progress = COALESCE($2::jsonb, '{}'::jsonb), updated_at = now() WHERE id = $1`,
		id, jsonbOrNil(progress),
	)
	return err
}

// Publish implements ports.EventBus: it appends an event to the outbox in the
// caller's transaction (the same tx as the job write). available_at defaults to
// now(), so the row drains on the next relay tick.
func (r *Repo) Publish(ctx context.Context, t ports.Tx, topic string, payload []byte) error {
	_, err := r.q(t).Exec(ctx,
		`INSERT INTO orchestrator.outbox (topic, payload) VALUES ($1, $2::jsonb)`,
		topic, string(payload))
	return err
}

// PublishAfter implements ports.EventBus: like Publish but stamps a not-before
// available_at of now()+delay, so the relay holds the row until then. Used to
// back off a retry re-dispatch (a delay<=0 falls back to an immediate row).
func (r *Repo) PublishAfter(ctx context.Context, t ports.Tx, topic string, payload []byte, delay time.Duration) error {
	if delay <= 0 {
		return r.Publish(ctx, t, topic, payload)
	}
	_, err := r.q(t).Exec(ctx,
		`INSERT INTO orchestrator.outbox (topic, payload, available_at)
		 VALUES ($1, $2::jsonb, now() + make_interval(secs => $3))`,
		topic, string(payload), delay.Seconds())
	return err
}

// --- Outbox drain (used by the redisstream relay) ---

// DrainUnpublished claims up to limit unpublished outbox rows with
// `FOR UPDATE SKIP LOCKED`, and — in the SAME transaction — publishes each via
// publish() and stamps it published. The row lock is what makes the relay
// safe to run on MULTIPLE orchestrator replicas: a second replica's SELECT skips
// the rows the first has claimed, so no event is XADDed twice by racing relays.
//
// Ordering is preserved (ORDER BY seq) and delivery stays at-least-once: a
// publish() error (or a crash) rolls the whole batch back, leaving those rows
// unpublished for the next tick — a duplicate XADD on the already-published
// prefix is absorbed by the idempotent consumers, exactly as before.
func (r *Repo) DrainUnpublished(ctx context.Context, limit int, publish func(topic string, payload []byte) error) (int, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// available_at <= now() holds back a backed-off retry row while letting every
	// immediate row (available_at defaults to now()) drain in seq order.
	rows, err := tx.Query(ctx,
		`SELECT seq, topic, payload FROM orchestrator.outbox
		  WHERE published_at IS NULL AND available_at <= now()
		  ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, err
	}
	// Buffer the batch before publishing: pgx forbids issuing the per-row UPDATE
	// while the SELECT cursor is still open on the same tx.
	type outboxRow struct {
		seq     int64
		topic   string
		payload []byte
	}
	var batch []outboxRow
	for rows.Next() {
		var row outboxRow
		if err := rows.Scan(&row.seq, &row.topic, &row.payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	n := 0
	for _, row := range batch {
		if err := publish(row.topic, row.payload); err != nil {
			return n, err // rollback: this batch stays unpublished, redelivered next tick
		}
		if _, err := tx.Exec(ctx,
			`UPDATE orchestrator.outbox SET published_at=now() WHERE seq=$1`, row.seq); err != nil {
			return n, err
		}
		n++
	}
	if err := tx.Commit(ctx); err != nil {
		return n, err
	}
	return n, nil
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
