// Package rcsync mirrors RevenueCat's view of a customer onto the user bound
// to it: it derives the tier snapshot from a refetched customer, writes it,
// announces the change downstream and records the webhook event as done.
package rcsync

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// rcResponseMalformedTotal counts customer bodies missing a required field
// (no `subscriber`, or no `original_app_user_id`). They fall back to a free
// snapshot, and the count lets an operator spot contract drift before it
// silently demotes paying users. It lives for the process and is not
// exported to Prometheus.
var rcResponseMalformedTotal atomic.Int64

// RCResponseMalformedTotal returns how many malformed customer bodies this
// process has seen.
func RCResponseMalformedTotal() int64 {
	return rcResponseMalformedTotal.Load()
}

// SnapshotFromRCResponse derives the durable tier state from a freshly
// fetched customer. Pro iff any entitlement is active (expiring after now, or
// never); tier_expires_at is the latest active expiry, nil for free or
// lifetime.
//
// now is the local time taken just before the request; SnapshotAt is
// RevenueCat's request_date_ms when the body carries it, otherwise now.
//
// A nil customer, a nil subscriber and missing entitlements all yield a
// clean free snapshot. A nil subscriber or a blank original_app_user_id is
// logged and counted as malformed.
func SnapshotFromRCResponse(appUserID string, resp *subscription.Customer, now time.Time) subscription.Snapshot {
	snap := subscription.Snapshot{AppUserID: appUserID, Tier: account.TierFree, SnapshotAt: now}
	if resp != nil && resp.RequestDateMs > 0 {
		snap.SnapshotAt = time.UnixMilli(resp.RequestDateMs).UTC()
	}
	if resp == nil {
		// The client answers a 404 with an empty customer, not nil, so nil
		// here is a caller's slip: logged, not counted as malformed.
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
		// The entitlements may still be readable; the missing field only
		// says the contract drifted.
	}
	if resp.Subscriber.Entitlements == nil {
		return snap
	}
	var latest *time.Time
	for _, ent := range resp.Subscriber.Entitlements {
		// A nil expiry is a lifetime entitlement. RevenueCat has also sent
		// the zero time on synthetic test payloads; read that as unset too,
		// or it would look like a 0001-01-01 expiry and demote the user.
		if ent.ExpiresDate == nil || ent.ExpiresDate.IsZero() {
			snap.Tier = account.TierPro
			latest = nil // a lifetime entitlement among the active ones wins
			break
		}
		if account.StillActive(*ent.ExpiresDate, now) {
			snap.Tier = account.TierPro
			if latest == nil || ent.ExpiresDate.After(*latest) {
				e := *ent.ExpiresDate
				latest = &e
			}
		}
	}
	if snap.Tier == account.TierPro {
		snap.TierExpiresAt = latest
	}
	return snap
}

// Service applies snapshots.
type Service struct {
	Store      ports.Store
	UnitOfWork ports.UnitOfWork
}

// RecordDelivery records a webhook delivery in its own unit of work: either
// it is the first sighting (inserted) or it reports whether an earlier
// delivery was processed.
func (s *Service) RecordDelivery(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error) {
	err = s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		ins, proc, e := tx.WebhookEvents().InsertOrLookup(ctx, eventID, appUserID)
		if e != nil {
			return e
		}
		inserted, processed = ins, proc
		return nil
	})
	return inserted, processed, err
}

// RecordError stores msg on the event while it is still unprocessed.
func (s *Service) RecordError(ctx context.Context, eventID, msg string) error {
	return s.Store.WebhookEvents().RecordError(ctx, eventID, msg)
}

// Apply writes the snapshot to the user bound to its customer, emits
// `subscription.changed` into the outbox and marks the webhook event
// processed — in one unit of work.
//
// The unit of work opens by locking the customer, so a webhook and its
// retries, or a webhook and the reconcile pass, serialise on one customer
// without blocking others.
//
// Returns:
//   - (userID, true, nil) — a user matched: state written, outbox event
//     emitted, event marked processed. Also when the user already holds a
//     newer snapshot: nothing is written and nothing emitted, but the event
//     is marked processed.
//   - (uuid.Nil, false, nil) — no user is bound to this customer yet (the
//     webhook beat the client's Purchases.logIn). The event stays
//     unprocessed so RevenueCat keeps retrying within its ~80-min budget;
//     past it, the reconcile pass's 7-day orphan sweep seals it.
//   - (uuid.Nil, false, err) — a database error; the event stays
//     unprocessed so RevenueCat or the reconcile pass retries.
func (s *Service) Apply(ctx context.Context, eventID string, snap subscription.Snapshot) (uuid.UUID, bool, error) {
	var (
		userID  uuid.UUID
		matched bool
	)
	err := s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		if err := tx.LockSubscriber(ctx, snap.AppUserID); err != nil {
			return fmt.Errorf("acquire subscription lock: %w", err)
		}

		// Under the lock, a sibling may already have processed this event:
		// the delivery check ran before this unit of work existed. This
		// re-check is what keeps one outbox row per event_id when many
		// retries queue up here.
		processed, err := tx.WebhookEvents().LookupProcessed(ctx, eventID)
		if err != nil {
			return fmt.Errorf("event_id lookup: %w", err)
		}
		if processed {
			// Read back the user the sibling touched so matched/userID stay
			// true to the contract. A failure here answers
			// (uuid.Nil, false): the webhook responds 200 duplicate either
			// way, so it is not an error.
			if id, ok, lerr := tx.Users().IDByRCAppUserID(ctx, snap.AppUserID); lerr == nil && ok {
				userID = id
				matched = true
			}
			return nil
		}

		id, outcome, err := tx.Users().UpsertSubscriptionState(ctx, snap)
		if err != nil {
			return fmt.Errorf("upsert subscription: %w", err)
		}
		userID = id
		switch outcome {
		case subscription.UpsertNoMatch:
			// processed_at stays NULL; the cause is recorded after the unit
			// of work, so it lands even if this one rolls back.
			return nil
		case subscription.UpsertStale:
			// A newer snapshot is already applied: nothing changed, no
			// outbox row; the event is sealed so RevenueCat stops redelivering.
			matched = true
			slog.InfoContext(ctx, "rc_snapshot_stale",
				"event_id", eventID,
				"rc_app_user_id", snap.AppUserID,
				"snapshot_at", snap.SnapshotAt,
			)
			if err := tx.WebhookEvents().MarkProcessed(ctx, eventID); err != nil {
				return fmt.Errorf("mark processed: %w", err)
			}
			return nil
		case subscription.UpsertApplied:
			matched = true
		}

		payload, err := json.Marshal(map[string]any{
			"tier":            snap.Tier,
			"tier_expires_at": snap.TierExpiresAt,
			"rc_app_user_id":  snap.AppUserID,
		})
		if err != nil {
			return fmt.Errorf("marshal outbox payload: %w", err)
		}
		// The outbox drops a second emission for the same event, covering
		// the edge cases the re-check above does not.
		if err := tx.Outbox().EmitSubscriptionChanged(ctx, userID, payload, eventID); err != nil {
			return fmt.Errorf("insert outbox: %w", err)
		}

		if err := tx.WebhookEvents().MarkProcessed(ctx, eventID); err != nil {
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
		// Recording the cause is a no-op once the event is processed, so it
		// is safe beside a concurrent orphan sweep. The outcome does not
		// depend on it; a failure is logged.
		if err := s.Store.WebhookEvents().RecordError(ctx, eventID, "no rc_app_user_id match"); err != nil {
			slog.ErrorContext(ctx, "rc_record_error_failed",
				"event_id", eventID, "err", err.Error())
		}
	}
	return userID, matched, nil
}
