package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaintenanceRepo owns cross-table operations: the per-user advisory lock and
// the full account purge.
type MaintenanceRepo struct{ Pool *pgxpool.Pool }

// AdvisoryXactLock takes pg_advisory_xact_lock(hashtext(user_id)) inside the
// caller's transaction, serializing one user's writes so global_seq is
// assigned in commit order. Released automatically at commit/rollback.
func AdvisoryXactLock(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, userID.String())
	return err
}

// purgeTables lists every profile table a user has rows in. chat_messages is
// removed by the chat_sessions cascade, but it is listed explicitly so the
// purge is total and order-independent (idempotent either way).
var purgeTables = []string{
	"profile.chat_messages",
	"profile.chat_sessions",
	"profile.notes",
	"profile.listening_sessions",
	"profile.playlist_items",
	"profile.library_items",
	"profile.library_memberships",
	"profile.sync_cursors",
	"profile.changes",
}

// PurgeUser deletes every row for a user across all profile tables in one
// transaction. Idempotent — a retried purge is a no-op.
func (r *MaintenanceRepo) PurgeUser(ctx context.Context, userID uuid.UUID) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, table := range purgeTables {
		if _, err := tx.Exec(ctx, "DELETE FROM "+table+" WHERE user_id = $1", userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
