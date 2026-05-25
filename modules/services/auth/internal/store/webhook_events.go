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

// InsertOrLookup atomically inserts a new event_id (+ app_user_id), or
// — when the row already exists — reports whether the previous attempt
// finished (`processed`). Collapses the old two-step
// SELECT-then-INSERT path that allowed a parallel RC retry to slip
// through between the two statements and emit a duplicate outbox row.
//
// Pass empty `appUserID` if the payload didn't carry one — we still
// want the row in place so RC sees its retries acknowledged, the
// orphan sweep just won't be able to do anything with it.
//
// Return value:
//   - (inserted=true, processed=false, nil)  → first sighting, caller proceeds
//   - (inserted=false, processed=true, nil)  → previous attempt completed; caller responds 200 duplicate
//   - (inserted=false, processed=false, nil) → previous attempt is still in flight or failed before MarkProcessed; caller takes the advisory lock and retries the apply step
//
// The `ON CONFLICT DO NOTHING RETURNING (xmax = 0) AS inserted` trick
// returns the row only when we actually inserted it (`xmax = 0` for a
// fresh tuple); when the conflict path triggers, the statement returns
// no row and we fall back to a deterministic SELECT to read the
// existing processed_at. Two round-trips on the conflict branch — same
// cost as the old code, but with no window for the race.
func (r *WebhookEventRepo) InsertOrLookup(ctx context.Context, tx pgx.Tx, eventID, appUserID string) (inserted, processed bool, err error) {
	var appUserIDArg any
	if appUserID != "" {
		appUserIDArg = appUserID
	}
	const ins = `INSERT INTO auth.rc_webhook_events(event_id, app_user_id)
	             VALUES ($1, $2)
	             ON CONFLICT (event_id) DO NOTHING
	             RETURNING (xmax = 0) AS inserted`
	row := selectRow(ctx, r.Pool, tx, ins, eventID, appUserIDArg)
	var ok bool
	if scanErr := row.Scan(&ok); scanErr != nil {
		if !errors.Is(scanErr, pgx.ErrNoRows) {
			return false, false, scanErr
		}
		// Conflict path — row already exists. Re-read processed_at.
	} else if ok {
		return true, false, nil
	}
	const lookup = `SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`
	var processedAt *time.Time
	if scanErr := selectRow(ctx, r.Pool, tx, lookup, eventID).Scan(&processedAt); scanErr != nil {
		return false, false, scanErr
	}
	return false, processedAt != nil, nil
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

// MarkProcessedWithError seals the event row as processed=now() but with
// a non-nil error string. Used for "permanent failure, stop retrying"
// outcomes (e.g. RC REST returns 401/403). Distinct from MarkProcessed
// which clears the error field; here we want to preserve the cause so
// ops can grep the table for why a given event never reached the
// `subscription.changed` outbox.
func (r *WebhookEventRepo) MarkProcessedWithError(ctx context.Context, eventID, msg string) error {
	_, err := r.Pool.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET processed_at = now(),
		        error = $2
		  WHERE event_id = $1`,
		eventID, msg,
	)
	return err
}

// OrphanedEvent is one row that the reconciliation cron's orphan sweep
// inspects: an event we received but never processed (no rc_app_user_id
// match was bound to any auth.users row in time). Past 7 days RC's
// retry budget is long gone — keeping these around forever turns the
// "unprocessed_count" metric into noise.
type OrphanedEvent struct {
	EventID    string
	AppUserID  string
	ReceivedAt time.Time
}

// ListOrphanedOlderThan returns webhook rows that never reached
// processed_at and whose received_at is older than `olderThan`. Used
// by the reconciliation cron's Step 3 (orphan sweep) to retry the
// REST refetch one last time, then mark them processed with
// error="orphaned_no_link" if the link still doesn't resolve.
//
// app_user_id is taken from the rc_webhook_events row itself — it's
// captured at receive time and stays put even if the user record
// never materialises. (Bounded to `limit` rows per call for the same
// reasons as UserRepo.ListStaleSubscribers.)
//
// NOTE: requires the `app_user_id` column on auth.rc_webhook_events,
// added by migration 0027_rc_webhook_app_user_id.
func (r *WebhookEventRepo) ListOrphanedOlderThan(ctx context.Context, olderThan time.Duration, limit int) ([]OrphanedEvent, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT event_id, app_user_id, received_at
		   FROM auth.rc_webhook_events
		  WHERE processed_at IS NULL
		    AND app_user_id IS NOT NULL
		    AND received_at < now() - make_interval(secs => $1)
		  ORDER BY received_at
		  LIMIT $2`,
		olderThan.Seconds(), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]OrphanedEvent, 0, limit)
	for rows.Next() {
		var e OrphanedEvent
		if err := rows.Scan(&e.EventID, &e.AppUserID, &e.ReceivedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkOrphaned stamps processed_at + sets error="orphaned_no_link" so
// the reconciliation cron's orphan sweep can stop retrying these.
// Used only by the cron — webhook handler never reaches this path
// because the unmatched ApplyRCSubscriberState leaves processed_at NULL
// on purpose to keep RC retrying within its 80-min budget.
func (r *WebhookEventRepo) MarkOrphaned(ctx context.Context, eventID string) error {
	_, err := r.Pool.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET processed_at = now(),
		        error = 'orphaned_no_link'
		  WHERE event_id = $1
		    AND processed_at IS NULL`,
		eventID,
	)
	return err
}
