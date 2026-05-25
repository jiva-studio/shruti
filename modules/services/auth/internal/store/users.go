package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
	ID         uuid.UUID
	Name       *string
	PictureURL *string
	CreatedAt  time.Time
	// Subscription state mirrored from RevenueCat. Defaults to "free" /
	// nil for users who never had Pro. Updated by the webhook handler
	// (Phase 2) and the reconciliation cron (Phase 8); the JWT signer
	// reads `Tier` at session issuance and embeds it as a claim.
	Tier            string
	TierExpiresAt   *time.Time
	TierUpdatedAt   *time.Time
	RCAppUserID     *string
}

type UserRepo struct{ Pool *pgxpool.Pool }

func (r *UserRepo) Create(ctx context.Context, tx pgx.Tx) (uuid.UUID, error) {
	var id uuid.UUID
	q := `INSERT INTO auth.users DEFAULT VALUES RETURNING id`
	if err := selectRow(ctx, r.Pool, tx, q).Scan(&id); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (r *UserRepo) Get(ctx context.Context, id uuid.UUID) (*User, error) {
	row := r.Pool.QueryRow(ctx,
		`SELECT id, name, picture_url, created_at,
		        tier, tier_expires_at, tier_updated_at, rc_app_user_id
		   FROM auth.users WHERE id = $1`, id)
	u := &User{}
	if err := row.Scan(
		&u.ID, &u.Name, &u.PictureURL, &u.CreatedAt,
		&u.Tier, &u.TierExpiresAt, &u.TierUpdatedAt, &u.RCAppUserID,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

// SubscriptionSnapshot is the canonical subscription state derived
// from a RevenueCat `GET /subscribers/{app_user_id}` response. Built
// by the webhook handler and applied via UpsertSubscriptionState.
type SubscriptionSnapshot struct {
	AppUserID     string
	Tier          string // "free" | "pro"
	TierExpiresAt *time.Time
}

// UpsertSubscriptionState writes the subscription columns for the
// user that owns the given rc_app_user_id. Returns (id, true) if a
// row matched and was updated; (uuid.Nil, false) if no row matched
// (webhook arrived before the client called Purchases.logIn — the
// reconciliation cron will pick it up later).
func (r *UserRepo) UpsertSubscriptionState(ctx context.Context, tx pgx.Tx, snap SubscriptionSnapshot) (uuid.UUID, bool, error) {
	var id uuid.UUID
	q := `UPDATE auth.users
	         SET tier = $2,
	             tier_expires_at = $3,
	             tier_updated_at = now()
	       WHERE rc_app_user_id = $1
	   RETURNING id`
	if err := selectRow(ctx, r.Pool, tx, q, snap.AppUserID, snap.Tier, snap.TierExpiresAt).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, false, nil
		}
		return uuid.Nil, false, err
	}
	return id, true, nil
}

// StaleSubscriber is one (user_id, rc_app_user_id) row whose subscription
// state is older than the reconciliation cron's threshold. The cron
// re-fetches each from RC and applies the snapshot to catch up.
type StaleSubscriber struct {
	UserID      uuid.UUID
	RCAppUserID string
}

// ListStaleSubscribers returns rows where `rc_app_user_id IS NOT NULL`
// AND either `tier_updated_at IS NULL` (never synced) OR
// `tier_updated_at < now() - staleAfter`. Used by the reconciliation
// cron to catch users whose webhooks got dropped between RC's retry
// budget and our backfill window.
//
// Bounded to `limit` rows per call — same rationale as
// WebhookEventRepo.ListUnprocessedOlderThan.
func (r *UserRepo) ListStaleSubscribers(ctx context.Context, staleAfter time.Duration, limit int) ([]StaleSubscriber, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT id, rc_app_user_id FROM auth.users
		  WHERE rc_app_user_id IS NOT NULL
		    AND (tier_updated_at IS NULL
		         OR tier_updated_at < now() - ($1 || ' seconds')::interval)
		  ORDER BY tier_updated_at NULLS FIRST
		  LIMIT $2`,
		int(staleAfter.Seconds()), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]StaleSubscriber, 0, limit)
	for rows.Next() {
		var s StaleSubscriber
		if err := rows.Scan(&s.UserID, &s.RCAppUserID); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// BindRCAppUserID associates a freshly-seen rc_app_user_id with our
// auth.users row. Called by the webhook handler when it can resolve
// the user via some other path (e.g. an existing rc_app_user_id is
// re-asserted) but the column is currently NULL — preserves the
// link for future events.
func (r *UserRepo) BindRCAppUserID(ctx context.Context, tx pgx.Tx, userID uuid.UUID, appUserID string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.users SET rc_app_user_id = $2 WHERE id = $1 AND rc_app_user_id IS NULL`,
		userID, appUserID,
	)
	return err
}

// SetNameIfEmpty writes name only when the existing column is NULL.
// Apple's fullName is one-time on first signin; we don't overwrite later.
func (r *UserRepo) SetNameIfEmpty(ctx context.Context, tx pgx.Tx, id uuid.UUID, name string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.users SET name = $2 WHERE id = $1 AND name IS NULL`,
		id, name,
	)
	return err
}

// SetPictureURL overwrites the URL on every call — Google rotates avatar
// URLs, so the last sign-in's value wins. Callers skip the call when the
// provider didn't return a picture (Apple).
func (r *UserRepo) SetPictureURL(ctx context.Context, tx pgx.Tx, id uuid.UUID, url string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.users SET picture_url = $2 WHERE id = $1`,
		id, url,
	)
	return err
}

// Delete cascades to identities and refresh_tokens via FK ON DELETE CASCADE,
// and fires the app.emit_user_deleted trigger which enqueues a `user.deleted`
// row into app.outbox in the same transaction. Pass a non-nil tx when the
// caller also needs to clean up rows outside the auth schema (e.g. the
// rate-limit `usage` table) atomically with the user row removal.
//
// Returns the number of rows affected so the caller can distinguish a real
// delete from a no-op (id already gone — second concurrent request, or a
// stale Bearer that survived a previous delete). Lets the handler map the
// latter to 410 Gone instead of 200 OK.
func (r *UserRepo) Delete(ctx context.Context, tx pgx.Tx, id uuid.UUID) (int64, error) {
	var (
		tag pgconn.CommandTag
		err error
	)
	if tx != nil {
		tag, err = tx.Exec(ctx, `DELETE FROM auth.users WHERE id = $1`, id)
	} else {
		tag, err = r.Pool.Exec(ctx, `DELETE FROM auth.users WHERE id = $1`, id)
	}
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
