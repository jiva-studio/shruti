package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Identity struct {
	Provider      string
	Subject       string
	UserID        uuid.UUID
	Email         *string
	EmailVerified bool
	CreatedAt     time.Time
}

type IdentityRepo struct{ Pool *pgxpool.Pool }

func (r *IdentityRepo) Get(ctx context.Context, provider, subject string) (*Identity, error) {
	row := r.Pool.QueryRow(ctx,
		`SELECT provider, subject, user_id, email, email_verified, created_at
		   FROM auth.identities
		  WHERE provider = $1 AND subject = $2`,
		provider, subject,
	)
	i := &Identity{}
	if err := row.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &i.EmailVerified, &i.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return i, nil
}

// Create inserts and returns the new row. ON CONFLICT not handled here —
// callers do the "lookup → maybe create" dance under their own tx.
func (r *IdentityRepo) Create(ctx context.Context, tx pgx.Tx, ident Identity) error {
	_, err := exec(ctx, r.Pool, tx,
		`INSERT INTO auth.identities
		   (provider, subject, user_id, email, email_verified)
		 VALUES ($1, $2, $3, $4, $5)`,
		ident.Provider, ident.Subject, ident.UserID, ident.Email, ident.EmailVerified,
	)
	return err
}

// UpdateEmail refreshes email/email_verified on an existing identity row.
// Used when Apple sends a different relay email on the same (apple, sub).
func (r *IdentityRepo) UpdateEmail(ctx context.Context, tx pgx.Tx, provider, subject string, email *string, verified bool) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.identities
		    SET email = $3, email_verified = $4
		  WHERE provider = $1 AND subject = $2`,
		provider, subject, email, verified,
	)
	return err
}

// FindUserByVerifiedEmail returns a user_id that already has any identity
// with this verified email — used for cross-provider linking on first signin.
func (r *IdentityRepo) FindUserByVerifiedEmail(ctx context.Context, email string) (uuid.UUID, error) {
	var uid uuid.UUID
	err := r.Pool.QueryRow(ctx,
		`SELECT user_id
		   FROM auth.identities
		  WHERE email = $1 AND email_verified
		  ORDER BY created_at ASC
		  LIMIT 1`,
		email,
	).Scan(&uid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, nil
		}
		return uuid.Nil, err
	}
	return uid, nil
}

// ListForUser returns all identities of a user, oldest first.
func (r *IdentityRepo) ListForUser(ctx context.Context, userID uuid.UUID) ([]Identity, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT provider, subject, user_id, email, email_verified, created_at
		   FROM auth.identities
		  WHERE user_id = $1
		  ORDER BY created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Identity
	for rows.Next() {
		var i Identity
		if err := rows.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &i.EmailVerified, &i.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// LatestVerifiedEmail returns the freshest verified email across a user's
// identities. Used to compute /auth/me's display email.
func (r *IdentityRepo) LatestVerifiedEmail(ctx context.Context, userID uuid.UUID) (*string, error) {
	var email *string
	err := r.Pool.QueryRow(ctx,
		`SELECT email FROM auth.identities
		  WHERE user_id = $1 AND email_verified
		  ORDER BY created_at DESC
		  LIMIT 1`,
		userID,
	).Scan(&email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return email, nil
}
