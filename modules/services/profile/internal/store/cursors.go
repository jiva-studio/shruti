package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CursorRepo records the highest global_seq each device has acknowledged.
type CursorRepo struct{ Pool *pgxpool.Pool }

// Ack upserts the device's acked_seq. acked_seq only moves forward
// (GREATEST) so an out-of-order or replayed ack can't rewind compaction.
func (r *CursorRepo) Ack(ctx context.Context, userID uuid.UUID, deviceID string, ackedSeq int64) error {
	_, err := r.Pool.Exec(ctx,
		`INSERT INTO profile.sync_cursors (user_id, device_id, acked_seq, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id, device_id)
		 DO UPDATE SET acked_seq  = GREATEST(profile.sync_cursors.acked_seq, EXCLUDED.acked_seq),
		               updated_at = now()`,
		userID, deviceID, ackedSeq,
	)
	return err
}
