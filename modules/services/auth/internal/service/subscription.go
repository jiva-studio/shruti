package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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

// SnapshotFromRCResponse derives the durable tier state from a fresh
// RC `GET /subscribers/{id}` body. Pro iff any entitlement is currently
// active (ExpiresDate in the future OR nil for lifetime). tier_expires_at
// is the latest active entitlement's expiry, NULL for free or lifetime.
//
// Lives next to the consumer (not in rcclient) so the rcclient package
// stays a pure REST shim — easier to test, easier to swap.
func SnapshotFromRCResponse(appUserID string, resp *rcclient.SubscriberResponse, now time.Time) store.SubscriptionSnapshot {
	snap := store.SubscriptionSnapshot{AppUserID: appUserID, Tier: TierFree}
	if resp == nil {
		return snap
	}
	var latest *time.Time
	for _, ent := range resp.Subscriber.Entitlements {
		// Lifetime entitlements have a nil ExpiresDate → always active.
		if ent.ExpiresDate == nil {
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
// Returns:
//   - (userID, true, nil) → matched a user, state updated, outbox event written
//   - (uuid.Nil, false, nil) → no auth.users row for this rc_app_user_id
//     (webhook arrived before client called Purchases.logIn). The webhook
//     event is still marked processed so RC stops retrying; the
//     reconciliation cron (Phase 8) will re-fetch when the client links.
//   - (uuid.Nil, false, err) → DB error; caller leaves the event unprocessed
//     so RC / cron can retry.
func (s *Service) ApplyRCSubscriberState(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	var (
		userID  uuid.UUID
		matched bool
	)
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		id, ok, err := s.Users.UpsertSubscriptionState(ctx, tx, snap)
		if err != nil {
			return fmt.Errorf("upsert subscription: %w", err)
		}
		matched = ok
		userID = id

		if ok {
			payload, err := json.Marshal(map[string]any{
				"tier":            snap.Tier,
				"tier_expires_at": snap.TierExpiresAt,
				"rc_app_user_id":  snap.AppUserID,
			})
			if err != nil {
				return fmt.Errorf("marshal outbox payload: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO app.outbox(event_type, aggregate_id, payload)
				 VALUES ('subscription.changed', $1::text, $2::jsonb)`,
				userID.String(), payload,
			); err != nil {
				return fmt.Errorf("insert outbox: %w", err)
			}
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
		slog.WarnContext(ctx, "rc_subscriber_no_match",
			"event_id", eventID,
			"rc_app_user_id", snap.AppUserID,
		)
	}
	return userID, matched, nil
}
