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

// UserDeleted returns a Handler that purges all Langfuse traces tagged
// with the deleted user's id. The aggregate_id IS the auth.users.id
// (uuid as text) — see the trigger definition in 0023_outbox.up.sql.
func UserDeleted(lf LangfusePurger) Handler {
	return func(ctx context.Context, evt Event) error {
		return lf.PurgeUserTraces(ctx, evt.AggregateID)
	}
}
