package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
)

// SubscriptionChangedPayload mirrors the JSON the auth webhook writes
// into app.outbox.payload when a RevenueCat event resolves to a tier
// change. We only need `tier` here; `tier_expires_at` / `rc_app_user_id`
// are kept in the payload for future observability handlers.
type SubscriptionChangedPayload struct {
	Tier string `json:"tier"`
}

// SubscriptionChanged returns a Handler that logs the tier transition.
// The handler is intentionally minimal in v1 — its job is just to mark
// the outbox row processed so it doesn't pile up (the registry's
// contract is that unhandled event_types stay forever; see
// handlers.Registry docstring).
//
// Why no side-effects today:
//
//   - Redis rate-limit keys are NOT cleared on downgrade. If we did, a
//     user with an about-to-expire Pro could burn all 200/day right
//     before expiry and get a fresh 10/day immediately after — abuse.
//     Day-bucketed TTLs reset naturally at UTC midnight.
//   - Multi-device "you got Pro" push is solved client-side via the
//     /auth/me resume sync (Phase 3); the server-side outbox event is
//     for future fan-out (analytics, email, push).
//
// `aggregate_id` is the auth.users.id (uuid as text) — see the INSERT
// in service.ApplyRCSubscriberState.
func SubscriptionChanged() Handler {
	return func(ctx context.Context, evt Event) error {
		var p SubscriptionChangedPayload
		if err := json.Unmarshal(evt.Payload, &p); err != nil {
			// Don't fail the event — payload schema can evolve, the row
			// is still valid as a "something changed" marker. Log loudly
			// so we notice if we ever forget to add a field here.
			slog.WarnContext(ctx, "subscription_changed_bad_payload",
				slog.String("aggregate_id", evt.AggregateID),
				slog.String("err", err.Error()),
			)
			return nil
		}
		slog.InfoContext(ctx, "subscription_changed",
			slog.String("user_id", evt.AggregateID),
			slog.String("tier", p.Tier),
		)
		return nil
	}
}
