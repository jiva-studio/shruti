package db

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Event is the in-memory shape of an app.outbox row that handlers see.
// The pgx-specific stuff (timestamps, transaction, row locks) is hidden
// inside this package.
type Event struct {
	ID          int64
	EventType   string
	AggregateID string
	Payload     json.RawMessage
}

// ClaimUnprocessedByType locks and returns up to `limit` unprocessed rows
// of the given event_type, oldest first. Caller commits or rolls back the
// transaction; mark-processed must run inside the same tx so the lock and
// the UPDATE travel together.
//
// Used by the LISTEN goroutine when a NOTIFY arrives: pg_notify tells us
// *what* event happened, then we SELECT the actual rows.
func ClaimUnprocessedByType(
	ctx context.Context,
	pool *pgxpool.Pool,
	eventType string,
	limit int,
) (pgx.Tx, []Event, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin: %w", err)
	}
	const q = `
		SELECT id, event_type, aggregate_id, payload
		FROM app.outbox
		WHERE processed_at IS NULL
		  AND event_type = $1
		ORDER BY occurred_at
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	`
	rows, err := tx.Query(ctx, q, eventType, limit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, fmt.Errorf("select by type: %w", err)
	}
	events, err := scanEvents(rows)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	return tx, events, nil
}

// ClaimUnprocessedSweep returns the oldest unprocessed rows older than
// 30 seconds — the durability path that catches anything LISTEN missed
// (dropped connection, worker downtime). The 30-second floor avoids
// racing the producer's NOTIFY: a row inserted right before our sweep
// would otherwise get picked up by both paths, and while the FOR UPDATE
// SKIP LOCKED prevents double-handling, the older threshold keeps the
// sweep query cheap on a hot table.
//
// `FOR UPDATE SKIP LOCKED` also makes it safe to run multiple worker
// replicas in future — each instance just gets a different slice.
func ClaimUnprocessedSweep(
	ctx context.Context,
	pool *pgxpool.Pool,
	limit int,
) (pgx.Tx, []Event, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin: %w", err)
	}
	const q = `
		SELECT id, event_type, aggregate_id, payload
		FROM app.outbox
		WHERE processed_at IS NULL
		  AND occurred_at < now() - interval '30 seconds'
		ORDER BY occurred_at
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`
	rows, err := tx.Query(ctx, q, limit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, fmt.Errorf("select sweep: %w", err)
	}
	events, err := scanEvents(rows)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	return tx, events, nil
}

// MarkProcessed stamps processed_at = now() on the given row inside the
// caller's transaction. Pair with the tx returned from a Claim* call.
func MarkProcessed(ctx context.Context, tx pgx.Tx, id int64) error {
	const q = `UPDATE app.outbox SET processed_at = now() WHERE id = $1`
	_, err := tx.Exec(ctx, q, id)
	return err
}

func scanEvents(rows pgx.Rows) ([]Event, error) {
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.EventType, &e.AggregateID, &e.Payload); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate: %w", err)
	}
	return out, nil
}
