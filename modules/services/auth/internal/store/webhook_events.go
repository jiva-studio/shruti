package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WebhookEvent represents one row of auth.rc_webhook_events. We don't
// load full rows during normal processing — the handler only needs to
// know whether the event has already been marked processed.
type WebhookEvent struct {
	EventID     string
	ReceivedAt  time.Time
	ProcessedAt *time.Time
	Error       *string
}

type WebhookEventRepo struct{ Pool *pgxpool.Pool }

// LookupProcessed returns:
//   - (true, nil)  → row exists AND processed_at IS NOT NULL.
//   - (false, nil) → row missing OR processed_at IS NULL.
//
// The caller maps the second case to "process me now": either we've
// never seen this event_id, or a previous attempt left processed_at
// unset (RC redelivery → retry the REST refetch).
func (r *WebhookEventRepo) LookupProcessed(ctx context.Context, tx pgx.Tx, eventID string) (bool, error) {
	row := selectRow(ctx, r.Pool, tx,
		`SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`, eventID)
	var processedAt *time.Time
	if err := row.Scan(&processedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return processedAt != nil, nil
}

// Insert is a no-op when the event_id already exists. Returns true if
// the row was actually inserted (first delivery), false if it was
// already there (redelivery or backfill replay).
func (r *WebhookEventRepo) Insert(ctx context.Context, tx pgx.Tx, eventID string) (bool, error) {
	const q = `INSERT INTO auth.rc_webhook_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING`
	if tx != nil {
		ct, err := tx.Exec(ctx, q, eventID)
		if err != nil {
			return false, err
		}
		return ct.RowsAffected() == 1, nil
	}
	ct, err := r.Pool.Exec(ctx, q, eventID)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() == 1, nil
}

// MarkProcessed sets processed_at = now() and clears any previous error.
// Called from inside the transaction that did the user UPDATE.
func (r *WebhookEventRepo) MarkProcessed(ctx context.Context, tx pgx.Tx, eventID string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.rc_webhook_events
		    SET processed_at = now(),
		        error = NULL
		  WHERE event_id = $1`,
		eventID,
	)
	return err
}

// RecordError stores the REST refetch failure on the (unprocessed) row.
// Runs in its own transaction so the failure log lands even when the
// outer tx is rolled back. processed_at stays NULL, which lets the
// reconciliation cron retry later.
func (r *WebhookEventRepo) RecordError(ctx context.Context, eventID, msg string) error {
	_, err := r.Pool.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET error = $2
		  WHERE event_id = $1 AND processed_at IS NULL`,
		eventID, msg,
	)
	return err
}
