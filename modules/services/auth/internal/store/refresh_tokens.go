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
	// Successor jti set when this token was rotated. nil for a live token
	// or one revoked without rotation (signout). Drives lost-response
	// replay recovery — see Service.Refresh.
	ReplacedBy *uuid.UUID
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
// /auth/refresh calls serialize through this lock. Also used to lock a
// presented token's successor when recovering a lost-response replay.
func (r *RefreshTokenRepo) LockAndRotate(ctx context.Context, tx pgx.Tx, jti uuid.UUID) (*RefreshToken, error) {
	row := tx.QueryRow(ctx,
		`SELECT jti, user_id, device_id, expires_at, revoked_at, replaced_by
		   FROM auth.refresh_tokens
		  WHERE jti = $1
		  FOR UPDATE`,
		jti,
	)
	rt := &RefreshToken{}
	if err := row.Scan(&rt.JTI, &rt.UserID, &rt.DeviceID, &rt.ExpiresAt, &rt.RevokedAt, &rt.ReplacedBy); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return rt, nil
}

// MarkRevoked stamps revoked_at = now() within the caller's tx. Leaves
// replaced_by NULL — for revocations that are NOT a rotation (signout),
// so a later replay correctly reads "revoked, no successor" and rejects.
func (r *RefreshTokenRepo) MarkRevoked(ctx context.Context, tx pgx.Tx, jti uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE auth.refresh_tokens SET revoked_at = now() WHERE jti = $1`,
		jti,
	)
	return err
}

// MarkRevokedWithSuccessor stamps revoked_at = now() AND records the
// successor jti, marking this token as rotated (not merely revoked). The
// pointer lets a lost-response retry rotate from the successor instead of
// forcing a re-login.
func (r *RefreshTokenRepo) MarkRevokedWithSuccessor(ctx context.Context, tx pgx.Tx, jti, successor uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE auth.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE jti = $1`,
		jti, successor,
	)
	return err
}
