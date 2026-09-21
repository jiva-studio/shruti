package service

import (
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/store"
)

// TestApplyRCSubscriberState_DedupSilencesDuplicateEventID verifies the
// promise of migration 0026_outbox_dedup: the same (event_type,
// source_event_id) pair can be INSERTed twice into app.outbox without
// erroring, and the second attempt becomes a silent no-op.
//
// This is the producer-side complement of Tier 1.2 (collapse lookup+insert
// in the webhook handler). Even if the upstream dedup check is bypassed —
// rc_webhook_events row torn between SELECT and INSERT — the partial unique
// index makes the duplicate outbox emission impossible.
func TestApplyRCSubscriberState_DedupSilencesDuplicateEventID(t *testing.T) {
	svc, _ := boot(t)
	ctx := t.Context()

	// Plumb the WebhookEvents repo manually — boot() doesn't wire it because
	// none of the pre-existing tests exercise the subscription path. Use the
	// same pool the service already uses; the repo is just a thin wrapper.
	svc.WebhookEvents = &store.WebhookEventRepo{Pool: svc.Pool}

	// Seed: one anonymous user, link them to a RC app_user_id, then insert
	// the corresponding rc_webhook_events row so MarkProcessed inside
	// ApplyRCSubscriberState has something to update.
	anon, err := svc.Anonymous(ctx, "dedup-device", "")
	if err != nil {
		t.Fatalf("anonymous bootstrap: %v", err)
	}
	if _, err := svc.Pool.Exec(ctx,
		`UPDATE auth.users SET rc_app_user_id = $1 WHERE id = $2`,
		"rcappuser-dedup", anon.UserID,
	); err != nil {
		t.Fatalf("set rc_app_user_id: %v", err)
	}

	eventID := "evt_dedup_X"
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO auth.rc_webhook_events (event_id) VALUES ($1)`, eventID,
	); err != nil {
		t.Fatalf("seed rc_webhook_events: %v", err)
	}

	future := time.Now().Add(30 * 24 * time.Hour)
	snap := store.SubscriptionSnapshot{
		AppUserID:     "rcappuser-dedup",
		Tier:          TierPro,
		TierExpiresAt: &future,
	}

	// First apply: should INSERT one outbox row.
	if _, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, snap); err != nil {
		t.Fatalf("first ApplyRCSubscriberState: %v", err)
	} else if !matched {
		t.Fatalf("first ApplyRCSubscriberState: expected matched=true")
	}

	// Reset processed_at so MarkProcessed inside the second apply doesn't
	// short-circuit on the same logic path the dedup is being tested against —
	// we want the second call to genuinely attempt the INSERT.
	if _, err := svc.Pool.Exec(ctx,
		`UPDATE auth.rc_webhook_events SET processed_at = NULL WHERE event_id = $1`,
		eventID,
	); err != nil {
		t.Fatalf("reset processed_at: %v", err)
	}

	// Second apply with identical eventID: must succeed (ON CONFLICT DO NOTHING)
	// and leave the outbox at exactly one row for this event.
	if _, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, snap); err != nil {
		t.Fatalf("second ApplyRCSubscriberState: %v", err)
	} else if !matched {
		t.Fatalf("second ApplyRCSubscriberState: expected matched=true")
	}

	var outboxCount int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		   WHERE event_type = 'subscription.changed' AND source_event_id = $1`,
		eventID,
	).Scan(&outboxCount); err != nil {
		t.Fatalf("count outbox rows: %v", err)
	}
	if outboxCount != 1 {
		t.Errorf("expected exactly 1 outbox row for event %q, got %d", eventID, outboxCount)
	}
}

// TestOutboxDedupIndex_RawInsertRejectsDuplicate is the bare-metal version of
// the test above: assert the unique partial index itself, without going through
// ApplyRCSubscriberState. Catches accidental rewrites of the producer that
// drop the ON CONFLICT clause — if the migration's index is doing its job,
// even a naïve INSERT must turn into a no-op when run through the same
// conflict target.
func TestOutboxDedupIndex_RawInsertRejectsDuplicate(t *testing.T) {
	svc, _ := boot(t)
	ctx := t.Context()

	const eventType = "subscription.changed"
	const sourceID = "evt_raw_dup"

	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO app.outbox (event_type, aggregate_id, payload, source_event_id)
		 VALUES ($1, $2, '{}'::jsonb, $3)`,
		eventType, "agg-1", sourceID,
	); err != nil {
		t.Fatalf("first INSERT: %v", err)
	}

	// Naked re-INSERT without ON CONFLICT must fail the unique constraint.
	_, err := svc.Pool.Exec(ctx,
		`INSERT INTO app.outbox (event_type, aggregate_id, payload, source_event_id)
		 VALUES ($1, $2, '{}'::jsonb, $3)`,
		eventType, "agg-2", sourceID,
	)
	if err == nil {
		t.Fatalf("expected duplicate INSERT to fail the unique index, got nil err")
	}
	if !asUnique(err) {
		t.Errorf("expected unique-violation error, got %T: %v", err, err)
	}

	// With ON CONFLICT DO NOTHING + matching the partial index, the duplicate
	// must succeed silently and add zero rows.
	ct, err := svc.Pool.Exec(ctx,
		`INSERT INTO app.outbox (event_type, aggregate_id, payload, source_event_id)
		 VALUES ($1, $2, '{}'::jsonb, $3)
		 ON CONFLICT (event_type, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
		eventType, "agg-3", sourceID,
	)
	if err != nil {
		t.Fatalf("ON CONFLICT DO NOTHING INSERT: %v", err)
	}
	if got := ct.RowsAffected(); got != 0 {
		t.Errorf("expected 0 rows affected on dup with ON CONFLICT, got %d", got)
	}

	// NULL source_event_id rows must NOT collide with each other — the
	// partial index excludes them by design (so events with no source id can
	// land as many times as the producer wants).
	for i := 0; i < 3; i++ {
		if _, err := svc.Pool.Exec(ctx,
			`INSERT INTO app.outbox (event_type, aggregate_id, payload, source_event_id)
			 VALUES ($1, $2, '{}'::jsonb, NULL)`,
			"user.deleted", "agg-null",
		); err != nil {
			t.Fatalf("NULL source_event_id INSERT %d: %v", i, err)
		}
	}
}

// asUnique returns true if err looks like a Postgres unique-violation.
// We do a string-match (SQLSTATE 23505) because pulling in pgconn.PgError
// just for this one assertion would noise up the test file's imports.
func asUnique(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key value")
}
