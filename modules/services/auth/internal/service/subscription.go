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

	"github.com/jiva-studio/shruti/auth/internal/rcclient"
	"github.com/jiva-studio/shruti/auth/internal/store"
)

// TierFree / TierPro are the only values the rate-limiter switches on
// today. The column is TEXT so a future "ultra" tier slides in without
// a schema change.
const (
	TierFree = "free"
	TierPro  = "pro"
)

// expiryGrace is a small slack applied to every "is this entitlement
// still active?" comparison so modest clock skew between this service,
// the DB, and RevenueCat doesn't flip a user Pro→free right at the
// boundary (and back again on the next refetch). Picked well under the
// shortest real subscription period so it can't keep a genuinely-expired
// user on Pro for any meaningful time — it only smooths the boundary.
const expiryGrace = 60 * time.Second

// stillActive reports whether an entitlement whose expiry is `exp` should
// still count as active at `now`, allowing for expiryGrace of skew.
func stillActive(exp, now time.Time) bool {
	return exp.After(now.Add(-expiryGrace))
}

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

// ErrGrantUserNotFound is returned by GrantAndApply when no auth.users
// row owns the given userID. The handler maps it to 404.
var ErrGrantUserNotFound = errors.New("grant: user not found")

// GrantAndApply grants a RevenueCat *promotional* "pro" entitlement to the
// user and immediately reflects it as tier=pro. RC does NOT fire a webhook
// on a promotional grant, so we refetch + apply right away instead of
// waiting for one — the reconcile cron is only a slow backstop.
//
// Steps:
//  1. Ensure rc_app_user_id is bound to userID.String() (idempotent;
//     BindRCAppUserID only writes when the column is NULL).
//  2. Grant the promotional entitlement on that RC app_user_id.
//  3. Refetch the subscriber + apply the resulting snapshot under a
//     synthetic event_id so tier=pro lands in auth.users now.
//
// `duration` is an RC promotional-duration token: "monthly" or "yearly".
func (s *Service) GrantAndApply(ctx context.Context, userID uuid.UUID, duration string) error {
	u, err := s.Users.Get(ctx, userID)
	if err != nil {
		return err
	}
	if u == nil {
		return ErrGrantUserNotFound
	}

	appUserID := userID.String()
	// Bind the RC app_user_id if it hasn't been set yet (e.g. the user
	// never completed a social signin). No-op once bound.
	if err := s.Users.BindRCAppUserID(ctx, nil, userID, appUserID); err != nil {
		return fmt.Errorf("grant: bind rc: %w", err)
	}

	entitlement := s.RCProEntitlement
	if entitlement == "" {
		entitlement = TierPro
	}
	if err := s.RC.GrantPromotional(ctx, appUserID, entitlement, duration); err != nil {
		return fmt.Errorf("grant: %w", err)
	}

	// RC doesn't webhook promo grants → refetch + apply now so tier=pro
	// is visible immediately rather than after the next reconcile tick.
	resp, err := s.RC.GetSubscriber(ctx, appUserID)
	if err != nil && !errors.Is(err, rcclient.ErrSubscriberNotFound) {
		return fmt.Errorf("grant: refetch: %w", err)
	}
	snap := SnapshotFromRCResponse(appUserID, resp, time.Now().UTC())
	eventID := fmt.Sprintf("billing-grant:%s:%s:%d", userID, duration, time.Now().Unix())
	if _, _, err := s.ApplyRCSubscriberState(ctx, eventID, snap); err != nil {
		return fmt.Errorf("grant: apply: %w", err)
	}
	return nil
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
		if stillActive(*ent.ExpiresDate, now) {
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

