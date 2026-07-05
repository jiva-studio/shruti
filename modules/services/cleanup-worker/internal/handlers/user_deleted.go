package handlers

import (
	"context"
)

// LangfusePurger is the narrow interface the user.deleted handler needs
// from the Langfuse client. Defined here (not in observability) so tests
// can swap in a fake without importing httptest plumbing.
type LangfusePurger interface {
	PurgeUserTraces(ctx context.Context, userID string) error
}

// ProfilePurger is the narrow interface the user.deleted handler needs from
// the profile-sync client. It tells the `profile` service (over HTTP, never
// its database) to erase the deleted user's synced data. Defined here so
// tests can supply a fake without the HTTP client. See profileclient.
type ProfilePurger interface {
	PurgeUser(ctx context.Context, userID string) error
}

// UserDeleted returns a Handler that erases everything the deleted user
// left behind outside the auth database: their Langfuse traces, and their
// synced profile data (library, history, notes, chat) on the `profile`
// service. The aggregate_id IS the auth.users.id (uuid as text) — see the
// trigger definition in 0023_outbox.up.sql.
//
// Ordering / idempotency: both steps are individually idempotent (Langfuse
// re-purge is a no-op empty GET; profile purge is a no-op on the service
// side), so the whole handler is safe to re-run. The Langfuse purge runs
// first and the profile purge last: if profile fails we return the error so
// the outbox retries, and re-running the already-completed Langfuse purge on
// that retry is harmless. Neither step must run before the other for
// correctness — the fixed order just keeps the retry story simple.
func UserDeleted(lf LangfusePurger, profile ProfilePurger) Handler {
	return func(ctx context.Context, evt Event) error {
		if err := lf.PurgeUserTraces(ctx, evt.AggregateID); err != nil {
			return err
		}
		return profile.PurgeUser(ctx, evt.AggregateID)
	}
}
