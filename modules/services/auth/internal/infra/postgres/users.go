package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

type users struct{ q querier }

func (r users) Create(ctx context.Context) (uuid.UUID, error) {
	var id uuid.UUID
	if err := r.q.QueryRow(ctx, `INSERT INTO auth.users DEFAULT VALUES RETURNING id`).Scan(&id); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (r users) Get(ctx context.Context, id uuid.UUID) (*account.User, error) {
	row := r.q.QueryRow(ctx,
		`SELECT id, name, picture_url, created_at,
		        tier, tier_expires_at, tier_updated_at, rc_app_user_id
		   FROM auth.users WHERE id = $1`, id)
	u := &account.User{}
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

func (r users) IDByRCAppUserID(ctx context.Context, appUserID string) (uuid.UUID, bool, error) {
	var id string
	err := r.q.QueryRow(ctx, `SELECT id FROM auth.users WHERE rc_app_user_id = $1`, appUserID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return uuid.Nil, false, err
	}
	return parsed, true, nil
}

// UpsertSubscriptionState writes the subscription columns for the user
// that owns snap.AppUserID, only when snap is not older than the snapshot
// already applied (rc_snapshot_at). A snapshot without SnapshotAt cannot
// be ordered, so it applies only while no timed snapshot is recorded and
// leaves rc_snapshot_at unset. Returns the user id for UpsertApplied and
// UpsertStale, uuid.Nil for UpsertNoMatch.
func (r users) UpsertSubscriptionState(ctx context.Context, snap subscription.Snapshot) (uuid.UUID, subscription.UpsertOutcome, error) {
	var at *time.Time
	if !snap.SnapshotAt.IsZero() {
		at = &snap.SnapshotAt
	}
	var id uuid.UUID
	q := `UPDATE auth.users
	         SET tier = $2,
	             tier_expires_at = $3,
	             tier_updated_at = now(),
	             rc_snapshot_at = COALESCE($4, rc_snapshot_at)
	       WHERE rc_app_user_id = $1
	         AND (rc_snapshot_at IS NULL OR rc_snapshot_at <= $4)
	   RETURNING id`
	err := r.q.QueryRow(ctx, q, snap.AppUserID, snap.Tier, snap.TierExpiresAt, at).Scan(&id)
	if err == nil {
		return id, subscription.UpsertApplied, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, subscription.UpsertNoMatch, err
	}
	err = r.q.QueryRow(ctx,
		`SELECT id FROM auth.users WHERE rc_app_user_id = $1`, snap.AppUserID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, subscription.UpsertNoMatch, nil
	}
	if err != nil {
		return uuid.Nil, subscription.UpsertNoMatch, err
	}
	return id, subscription.UpsertStale, nil
}

func (r users) ListStaleSubscribers(ctx context.Context, staleAfter time.Duration, limit int) ([]subscription.StaleSubscriber, error) {
	rows, err := r.q.Query(ctx,
		`SELECT id, rc_app_user_id FROM auth.users
		  WHERE rc_app_user_id IS NOT NULL
		    AND (tier_updated_at IS NULL
		         OR tier_updated_at < now() - make_interval(secs => $1))
		  ORDER BY tier_updated_at NULLS FIRST
		  LIMIT $2`,
		staleAfter.Seconds(), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]subscription.StaleSubscriber, 0, limit)
	for rows.Next() {
		var s subscription.StaleSubscriber
		if err := rows.Scan(&s.UserID, &s.RCAppUserID); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r users) BindRCAppUserID(ctx context.Context, userID uuid.UUID, appUserID string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.users SET rc_app_user_id = $2 WHERE id = $1 AND rc_app_user_id IS NULL`,
		userID, appUserID,
	)
	return err
}

func (r users) SetNameIfEmpty(ctx context.Context, id uuid.UUID, name string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.users SET name = $2 WHERE id = $1 AND name IS NULL`,
		id, name,
	)
	return err
}

func (r users) SetPictureURL(ctx context.Context, id uuid.UUID, url string) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.users SET picture_url = $2 WHERE id = $1`,
		id, url,
	)
	return err
}

// Delete cascades to identities and refresh_tokens via FK ON DELETE CASCADE,
// and fires the app.emit_user_deleted trigger which enqueues a `user.deleted`
// row into app.outbox in the same transaction.
func (r users) Delete(ctx context.Context, id uuid.UUID) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM auth.users WHERE id = $1`, id)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
