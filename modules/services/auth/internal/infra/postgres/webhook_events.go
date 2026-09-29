package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

// webhookEvents is auth.rc_webhook_events: one row per RevenueCat delivery,
// processed_at set once it was applied or deliberately sealed.
type webhookEvents struct{ q querier }

// LookupProcessed is false both for an unknown event and for one whose
// earlier attempt left processed_at unset.
func (r webhookEvents) LookupProcessed(ctx context.Context, eventID string) (bool, error) {
	row := r.q.QueryRow(ctx,
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

// InsertOrLookup inserts the event (with its customer id, NULL when empty)
// or, when it exists, reads back whether it was processed. The insert comes
// first, so a parallel retry cannot slip in between a SELECT and an INSERT.
// `RETURNING (xmax = 0)` yields a row only for a fresh tuple; on conflict the
// statement returns nothing and a second query reads processed_at.
func (r webhookEvents) InsertOrLookup(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error) {
	var appUserIDArg any
	if appUserID != "" {
		appUserIDArg = appUserID
	}
	const ins = `INSERT INTO auth.rc_webhook_events(event_id, app_user_id)
	             VALUES ($1, $2)
	             ON CONFLICT (event_id) DO NOTHING
	             RETURNING (xmax = 0) AS inserted`
	var ok bool
	if scanErr := r.q.QueryRow(ctx, ins, eventID, appUserIDArg).Scan(&ok); scanErr != nil {
		if !errors.Is(scanErr, pgx.ErrNoRows) {
			return false, false, scanErr
		}
	} else if ok {
		return true, false, nil
	}
	const lookup = `SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`
	var processedAt *time.Time
	if scanErr := r.q.QueryRow(ctx, lookup, eventID).Scan(&processedAt); scanErr != nil {
		return false, false, scanErr
	}
	return false, processedAt != nil, nil
}

// MarkProcessed sets processed_at and clears any recorded error.
func (r webhookEvents) MarkProcessed(ctx context.Context, eventID string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET processed_at = now(),
		        error = NULL
		  WHERE event_id = $1`,
		eventID,
	)
	return err
}

// RecordError stores msg on an unprocessed row; processed_at stays NULL so
// RevenueCat or the reconcile pass retries later.
func (r webhookEvents) RecordError(ctx context.Context, eventID, msg string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET error = $2
		  WHERE event_id = $1 AND processed_at IS NULL`,
		eventID, msg,
	)
	return err
}

// ListOrphanedOlderThan reads app_user_id from the event row itself, captured
// at receipt (migration 0027_rc_webhook_app_user_id).
func (r webhookEvents) ListOrphanedOlderThan(ctx context.Context, olderThan time.Duration, limit int) ([]subscription.OrphanedEvent, error) {
	rows, err := r.q.Query(ctx,
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
	out := make([]subscription.OrphanedEvent, 0, limit)
	for rows.Next() {
		var e subscription.OrphanedEvent
		if err := rows.Scan(&e.EventID, &e.AppUserID, &e.ReceivedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkOrphaned stamps processed_at with error 'orphaned_no_link' so the
// orphan sweep stops retrying the event.
func (r webhookEvents) MarkOrphaned(ctx context.Context, eventID string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.rc_webhook_events
		    SET processed_at = now(),
		        error = 'orphaned_no_link'
		  WHERE event_id = $1
		    AND processed_at IS NULL`,
		eventID,
	)
	return err
}
