package postgres

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type subscriptionGrants struct{ q querier }

// Reserve inserts the grant on first call; the no-op ON CONFLICT update lets
// RETURNING yield the stored granted_until on every later call.
func (r subscriptionGrants) Reserve(ctx context.Context, grantKey string, userID uuid.UUID, duration string, desired time.Time) (time.Time, error) {
	var stored time.Time
	err := r.q.QueryRow(ctx,
		`INSERT INTO auth.subscription_grants (grant_key, user_id, duration, granted_until)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (grant_key) DO UPDATE SET grant_key = auth.subscription_grants.grant_key
		 RETURNING granted_until`,
		grantKey, userID, duration, desired,
	).Scan(&stored)
	return stored, err
}

type outbox struct{ q querier }

// EmitSubscriptionChanged relies on outbox_dedup_idx (event_type,
// source_event_id): a second insert for the same source event is a no-op.
func (r outbox) EmitSubscriptionChanged(ctx context.Context, userID uuid.UUID, payload []byte, sourceEventID string) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO app.outbox(event_type, aggregate_id, payload, source_event_id)
		 VALUES ('subscription.changed', $1::text, $2::jsonb, $3::text)
		 ON CONFLICT (event_type, source_event_id)
		   WHERE source_event_id IS NOT NULL
		   DO NOTHING`,
		userID.String(), payload, sourceEventID,
	)
	return err
}
