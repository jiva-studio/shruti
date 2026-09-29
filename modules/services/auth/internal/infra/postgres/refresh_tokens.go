package postgres

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

type refreshTokens struct{ q querier }

func (r refreshTokens) Create(ctx context.Context, t account.RefreshToken) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO auth.refresh_tokens (jti, user_id, device_id, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		t.JTI, t.UserID, t.DeviceID, t.ExpiresAt,
	)
	return err
}

// LockForRotation selects the token FOR UPDATE, so two /auth/refresh calls
// on one token serialise here.
func (r refreshTokens) LockForRotation(ctx context.Context, jti uuid.UUID) (*account.RefreshToken, error) {
	row := r.q.QueryRow(ctx,
		`SELECT jti, user_id, device_id, expires_at, revoked_at, replaced_by
		   FROM auth.refresh_tokens
		  WHERE jti = $1
		  FOR UPDATE`,
		jti,
	)
	rt := &account.RefreshToken{}
	if err := row.Scan(&rt.JTI, &rt.UserID, &rt.DeviceID, &rt.ExpiresAt, &rt.RevokedAt, &rt.ReplacedBy); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return rt, nil
}

func (r refreshTokens) MarkRevoked(ctx context.Context, jti uuid.UUID) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.refresh_tokens SET revoked_at = now() WHERE jti = $1`,
		jti,
	)
	return err
}

func (r refreshTokens) MarkRevokedWithSuccessor(ctx context.Context, jti, successor uuid.UUID) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE jti = $1`,
		jti, successor,
	)
	return err
}

func (r refreshTokens) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.refresh_tokens
		    SET revoked_at = now()
		  WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
	return err
}
