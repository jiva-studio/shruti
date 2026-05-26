package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/akdasa-studios/shruti/auth/internal/rcclient"
	"github.com/akdasa-studios/shruti/auth/internal/store"
)

// TierFree / TierPro are the only values the rate-limiter switches on
// today. The column is TEXT so a future "ultra" tier slides in without
// a schema change.
const (
	TierFree = "free"
	TierPro  = "pro"
)

// rcResponseMalformedTotal counts RC `GET /subscribers/{id}` payloads
// where a required field was missing (no `subscriber` object, or no
// `original_app_user_id` on it). We treat these as recoverable — fall
// back to a free-tier snapshot — but log + count so an operator can
// spot a contract regression (RC field rename, new RC API version,
// etc.) before it silently demotes paying users.
//
// Exported via RCResponseMalformedTotal so tests can read it. We
// deliberately do not wire a Prometheus registry yet — the broader
// observability work in Phase 9 will register the variable; for now
// it's a process-lifetime atomic, good enough for tests and easy to
// expose later via /metrics.
var rcResponseMalformedTotal atomic.Int64

// RCResponseMalformedTotal returns the current count of malformed RC
// responses observed by SnapshotFromRCResponse this process.
func RCResponseMalformedTotal() int64 {
	return rcResponseMalformedTotal.Load()
}

// SnapshotFromRCResponse derives the durable tier state from a fresh
// RC `GET /subscribers/{id}` body. Pro iff any entitlement is currently
// active (ExpiresDate in the future OR nil for lifetime). tier_expires_at
// is the latest active entitlement's expiry, NULL for free or lifetime.
//
// Robustness contract: nil response, nil Subscriber, nil/empty
// Entitlements, and missing required fields all yield a clean free-tier
// snapshot — never a panic. Malformed bodies (nil Subscriber, blank
// OriginalAppUserID) bump rc_response_malformed_total and log INFO so
// we can spot contract drift.
//
// Lives next to the consumer (not in rcclient) so the rcclient package
// stays a pure REST shim — easier to test, easier to swap.
func SnapshotFromRCResponse(appUserID string, resp *rcclient.SubscriberResponse, now time.Time) store.SubscriptionSnapshot {
	snap := store.SubscriptionSnapshot{AppUserID: appUserID, Tier: TierFree}
	if resp == nil {
		// nil resp on a 404 ("subscriber not found") is normal — the
		// rcclient returns &SubscriberResponse{} for that, not nil — so
		// reaching here usually means a programming error upstream. Log
		// INFO but don't count it as malformed payload; treat as free.
		slog.Info("rc_response_nil", "app_user_id", appUserID)
		return snap
	}
	if resp.Subscriber == nil {
		rcResponseMalformedTotal.Add(1)
		slog.Info("rc_response_malformed",
			"app_user_id", appUserID, "reason", "subscriber_nil")
		return snap
	}
	if resp.Subscriber.OriginalAppUserID == "" {
		rcResponseMalformedTotal.Add(1)
		slog.Info("rc_response_malformed",
			"app_user_id", appUserID, "reason", "missing_original_app_user_id")
		// Don't bail — entitlements may still be derivable; the missing
		// field tells us the contract drifted, not that the body is
		// useless.
	}
	if resp.Subscriber.Entitlements == nil {
		return snap
	}
	var latest *time.Time
	for _, ent := range resp.Subscriber.Entitlements {
		// Lifetime entitlements have a nil ExpiresDate → always active.
		// RC has also been observed to emit the zero time on synthetic
		// test payloads; treat that as "unset" too (otherwise a zero
		// time looks like a 0001-01-01 expiry, which is before any
		// `now`, and we'd silently demote the user to free).
		if ent.ExpiresDate == nil || ent.ExpiresDate.IsZero() {
			snap.Tier = TierPro
			latest = nil // a nil among any active → "never expires" wins
			break
		}
		if ent.ExpiresDate.After(now) {
			snap.Tier = TierPro
			if latest == nil || ent.ExpiresDate.After(*latest) {
				e := *ent.ExpiresDate
				latest = &e
			}
		}
	}
	if snap.Tier == TierPro {
		snap.TierExpiresAt = latest
	}
	return snap
}

// ApplyRCSubscriberState writes the snapshot to auth.users (matching by
// rc_app_user_id), emits a `subscription.changed` event into app.outbox,
// and marks the corresponding rc_webhook_events row processed — all in
// one transaction.
//
// Concurrency: the tx opens by taking an advisory lock keyed on
// rc_app_user_id. Serialises webhook + reconcile cron mutual exclusion
// on the same RC customer without blocking unrelated users; released
// automatically on commit/rollback. Plan 1.4.
//
// Returns:
//   - (userID, true, nil) → matched a user, state updated, outbox event
//     written, webhook row marked processed.
//   - (uuid.Nil, false, nil) → no auth.users row for this rc_app_user_id
//     (webhook arrived before client called Purchases.logIn). The
//     webhook row stays unprocessed (processed_at IS NULL) so RC keeps
//     retrying within its 80-min budget — by then the client should
//     have called logIn and the retry will match. After that, the
//     reconciliation cron's orphan sweep (7-day cutoff) stamps the row
//     with error='orphaned_no_link' so it doesn't accumulate forever.
//     Plan 1.3.
//   - (uuid.Nil, false, err) → DB error; caller leaves the event unprocessed
//     so RC / cron can retry.
func (s *Service) ApplyRCSubscriberState(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	var (
		userID  uuid.UUID
		matched bool
	)
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// Per-rc_app_user_id advisory lock: two webhook retries (or a
		// webhook + reconcile cron) targeting the same customer will
		// serialise here, so they never both write conflicting
		// snapshots or fan out two outbox rows. hashtext gives Postgres
		// the two int4 halves of the lock key — combined with the
		// constant tag they don't collide with other advisory locks
		// (e.g. handler.waitForSibling on event_id).
		if _, err := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtext('rc-subscription'), hashtext($1))`,
			snap.AppUserID,
		); err != nil {
			return fmt.Errorf("acquire subscription lock: %w", err)
		}

		// Inside the lock: short-circuit if a sibling already marked
		// this event_id processed. The InsertOrLookup handler check is
		// racy (the check + insert run before this tx exists); the
		// rc-subscription lock is the canonical serialisation point
		// for plan 1.2's "exactly one outbox row per event_id"
		// invariant. Without this re-check, ten concurrent retries
		// would queue up here and each one would re-emit the outbox.
		var processedAt *time.Time
		if err := tx.QueryRow(ctx,
			`SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`,
			eventID,
		).Scan(&processedAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("event_id lookup: %w", err)
		}
		if processedAt != nil {
			// Sibling finished first — read back the user we touched
			// so the caller's matched=true / userID contract still
			// holds. Failing softly to (uuid.Nil, false) is also OK
			// because the handler responds 200/duplicate either way.
			var uid string
			if err := tx.QueryRow(ctx,
				`SELECT id FROM auth.users WHERE rc_app_user_id = $1`,
				snap.AppUserID,
			).Scan(&uid); err == nil {
				if parsed, perr := uuid.Parse(uid); perr == nil {
					userID = parsed
					matched = true
				}
			}
			return nil
		}

		id, ok, err := s.Users.UpsertSubscriptionState(ctx, tx, snap)
		if err != nil {
			return fmt.Errorf("upsert subscription: %w", err)
		}
		matched = ok
		userID = id

		if !ok {
			// Leave processed_at NULL and record the cause so the
			// orphan sweep (or the next RC retry) can pick this up.
			// Done OUTSIDE the tx via RecordError (the failure log
			// must land even if a later error rolls this tx back).
			return nil
		}

		payload, err := json.Marshal(map[string]any{
			"tier":            snap.Tier,
			"tier_expires_at": snap.TierExpiresAt,
			"rc_app_user_id":  snap.AppUserID,
		})
		if err != nil {
			return fmt.Errorf("marshal outbox payload: %w", err)
		}
		// Dedup: source_event_id = RC eventID, paired with event_type
		// 'subscription.changed' via outbox_dedup_idx (migration 0026).
		// If the same RC event somehow reaches this INSERT twice
		// (auth.rc_webhook_events idempotency torn between SELECT and
		// INSERT — see Tier 1.2 in the improvement plan), the unique
		// partial index turns the second attempt into a silent no-op
		// instead of double-fanning the consumer side. The intra-tx
		// processed_at re-check above already short-circuits the
		// common race; this guard handles the edge cases.
		if _, err := tx.Exec(ctx,
			`INSERT INTO app.outbox(event_type, aggregate_id, payload, source_event_id)
			 VALUES ('subscription.changed', $1::text, $2::jsonb, $3::text)
			 ON CONFLICT (event_type, source_event_id)
			   WHERE source_event_id IS NOT NULL
			   DO NOTHING`,
			userID.String(), payload, eventID,
		); err != nil {
			return fmt.Errorf("insert outbox: %w", err)
		}

		if err := s.WebhookEvents.MarkProcessed(ctx, tx, eventID); err != nil {
			return fmt.Errorf("mark processed: %w", err)
		}
		return nil
	})
	if err != nil {
		return uuid.Nil, false, err
	}
	if !matched {
		slog.InfoContext(ctx, "rc_subscriber_no_match",
			"event_id", eventID,
			"rc_app_user_id", snap.AppUserID,
		)
		// Best-effort: record the cause on the unprocessed row.
		// RecordError runs in its own tx and is a no-op once
		// processed_at is non-NULL, so it's safe under concurrent
		// orphan-sweep activity.
		_ = s.WebhookEvents.RecordError(ctx, eventID, "no rc_app_user_id match")
	}
	return userID, matched, nil
}

// ApplyRemoteSubscription receives an RC subscriber-state snapshot
// from another region via the cross-region outbox broadcast (PR-2b
// builds the sender; PR-2a wires the receiver). Idempotency on the
// snapshot's event_id is shared with the local RC webhook path: the
// auth.rc_webhook_events table dedupes both the in-region delivery
// and any number of remote redeliveries on the same eventID.
//
// Semantics differ from ApplyRCSubscriberState in one important way:
// here we do NOT emit a subscription.broadcast outbox row on apply.
// The originating region already wrote one; re-broadcasting on
// receipt would loop. The caller fans out by writing
// subscription.broadcast on the *send* side only.
//
// Returns:
//   - (true, nil)  → local user matched + state updated. The matched
//     bool flows back to the caller so the broadcaster can short-
//     circuit further fan-out (the migrated-from region keeps
//     delivering until at least one region claims the user, then
//     stops).
//   - (false, nil) → no local user owns this rc_app_user_id; treated as
//     a clean miss (the user lives on a different region). Idempotency
//     row is still inserted so RC-style retries dedup.
//   - (matched, err) for a duplicate event_id: matched reflects what
//     the previous winner observed; err is nil.
func (s *Service) ApplyRemoteSubscription(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (bool, error) {
	var matched bool
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// InsertOrLookup is atomic against concurrent deliveries from
		// multiple source regions hammering the same event. inserted=
		// false + processed=true → a sibling already finished; we look
		// up whether they matched a local user so the caller can log
		// a useful matched flag.
		inserted, processed, err := s.WebhookEvents.InsertOrLookup(ctx, tx, eventID, snap.AppUserID)
		if err != nil {
			return fmt.Errorf("event idempotency: %w", err)
		}
		if !inserted && processed {
			// Already handled by an earlier delivery. Determine
			// whether it matched by checking if our local user row
			// carries the rc_app_user_id.
			var anyMatch bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM auth.users WHERE rc_app_user_id = $1)`,
				snap.AppUserID,
			).Scan(&anyMatch); err != nil {
				return fmt.Errorf("dup match probe: %w", err)
			}
			matched = anyMatch
			return nil
		}
		// Fresh delivery (or a sibling left processed_at=NULL on a
		// previous failure → safe to retry). Apply the snapshot.
		_, ok, err := s.Users.UpsertSubscriptionState(ctx, tx, snap)
		if err != nil {
			return fmt.Errorf("upsert remote subscription: %w", err)
		}
		matched = ok
		// Mark processed regardless of match. A miss is still a
		// completed event from the broadcaster's point of view —
		// retrying delivery to a region that doesn't own the user
		// burns the broadcaster's retry budget for no gain.
		if err := s.WebhookEvents.MarkProcessed(ctx, tx, eventID); err != nil {
			return fmt.Errorf("mark processed: %w", err)
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return matched, nil
}
