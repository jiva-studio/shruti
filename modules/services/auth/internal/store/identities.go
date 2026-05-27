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
	Provider string
	Subject  string
	UserID   uuid.UUID
	Email    *string
	// EmailVerified is exposed as a plain bool to keep service.go and
	// the JWT claim builder simple. The underlying column is nullable
	// after migration 0029 (a region that disables email collection
	// writes NULL); scans coerce NULL → false here. PR-1.5b will use
	// the EmailVerifiedNull helper when it needs to write NULL.
	EmailVerified bool
	CreatedAt     time.Time
	// HomeRegion stamps the regional deployment that owns this identity
	// row. Default 'global' is filled by the DB on plain INSERTs; the
	// migrate-in path (PR-2a) writes the destination region explicitly.
	HomeRegion string
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
	var verified *bool
	if err := row.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &verified, &i.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if verified != nil {
		i.EmailVerified = *verified
	}
	return i, nil
}

// Create inserts and returns the new row. ON CONFLICT not handled here —
// callers do the "lookup → maybe create" dance under their own tx.
//
// HomeRegion is written explicitly only when non-empty; an empty string
// falls back to the DB column default ('global', set by migration 0028).
// The migrate-in path sets it to the destination region so the row is
// stamped correctly on insert without a second UPDATE.
func (r *IdentityRepo) Create(ctx context.Context, tx pgx.Tx, ident Identity) error {
	if ident.HomeRegion == "" {
		_, err := exec(ctx, r.Pool, tx,
			`INSERT INTO auth.identities
			   (provider, subject, user_id, email, email_verified)
			 VALUES ($1, $2, $3, $4, $5)`,
			ident.Provider, ident.Subject, ident.UserID, ident.Email, ident.EmailVerified,
		)
		return err
	}
	_, err := exec(ctx, r.Pool, tx,
		`INSERT INTO auth.identities
		   (provider, subject, user_id, email, email_verified, home_region)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		ident.Provider, ident.Subject, ident.UserID, ident.Email, ident.EmailVerified, ident.HomeRegion,
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
	return scanIdentities(rows)
}

// GetTx mirrors Get but reads inside the caller's transaction so the
// migrate-in conflict-resolution path sees rows it just deleted in the
// same tx. Returns (nil, nil) on miss.
func (r *IdentityRepo) GetTx(ctx context.Context, tx pgx.Tx, provider, subject string) (*Identity, error) {
	row := tx.QueryRow(ctx,
		`SELECT provider, subject, user_id, email, email_verified, created_at
		   FROM auth.identities
		  WHERE provider = $1 AND subject = $2`,
		provider, subject,
	)
	i := &Identity{}
	var verified *bool
	if err := row.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &verified, &i.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if verified != nil {
		i.EmailVerified = *verified
	}
	return i, nil
}

// ListForUserTx mirrors ListForUser but reads inside the caller's
// transaction. Used by migrate-in's anon-conflict resolution to verify
// the conflicting user is anonymous-only before deleting them.
func (r *IdentityRepo) ListForUserTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID) ([]Identity, error) {
	rows, err := tx.Query(ctx,
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
	return scanIdentities(rows)
}

func scanIdentities(rows pgx.Rows) ([]Identity, error) {
	var out []Identity
	for rows.Next() {
		var i Identity
		var verified *bool
		if err := rows.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &verified, &i.CreatedAt); err != nil {
			return nil, err
		}
		if verified != nil {
			i.EmailVerified = *verified
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
