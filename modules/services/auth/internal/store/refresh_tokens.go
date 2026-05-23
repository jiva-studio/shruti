package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RefreshToken struct {
	JTI       uuid.UUID
	UserID    uuid.UUID
	DeviceID  *string
	ExpiresAt time.Time
	RevokedAt *time.Time
}

type RefreshTokenRepo struct{ Pool *pgxpool.Pool }

func (r *RefreshTokenRepo) Create(ctx context.Context, tx pgx.Tx, t RefreshToken) error {
	_, err := exec(ctx, r.Pool, tx,
		`INSERT INTO auth.refresh_tokens (jti, user_id, device_id, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		t.JTI, t.UserID, t.DeviceID, t.ExpiresAt,
	)
	return err
}

// LockAndRotate runs the canonical refresh-rotation step under SELECT FOR UPDATE.
// Returns the *currently locked* row so the caller can verify expiry, then
// itself revoke it within the same tx and issue a new token. Two simultaneous
// /auth/refresh calls serialize through this lock.
func (r *RefreshTokenRepo) LockAndRotate(ctx context.Context, tx pgx.Tx, jti uuid.UUID) (*RefreshToken, error) {
	row := tx.QueryRow(ctx,
		`SELECT jti, user_id, device_id, expires_at, revoked_at
		   FROM auth.refresh_tokens
		  WHERE jti = $1
		  FOR UPDATE`,
		jti,
	)
	rt := &RefreshToken{}
	if err := row.Scan(&rt.JTI, &rt.UserID, &rt.DeviceID, &rt.ExpiresAt, &rt.RevokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return rt, nil
}

// MarkRevoked stamps revoked_at = now() within the caller's tx.
func (r *RefreshTokenRepo) MarkRevoked(ctx context.Context, tx pgx.Tx, jti uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE auth.refresh_tokens SET revoked_at = now() WHERE jti = $1`,
		jti,
	)
	return err
}
