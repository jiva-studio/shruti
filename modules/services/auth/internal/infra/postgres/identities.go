package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

type identities struct{ q querier }

// email_verified is nullable (a region that disables email collection writes
// NULL); scans coerce NULL to false.

func (r identities) Get(ctx context.Context, provider, subject string) (*account.Identity, error) {
	row := r.q.QueryRow(ctx,
		`SELECT provider, subject, user_id, email, email_verified, created_at
		   FROM auth.identities
		  WHERE provider = $1 AND subject = $2`,
		provider, subject,
	)
	i := &account.Identity{}
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

// uniqueViolation is the Postgres SQLSTATE for a unique-constraint violation.
const uniqueViolation = "23505"

func (r identities) Create(ctx context.Context, ident account.Identity) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO auth.identities
		   (provider, subject, user_id, email, email_verified)
		 VALUES ($1, $2, $3, $4, $5)`,
		ident.Provider, ident.Subject, ident.UserID, ident.Email, ident.EmailVerified,
	)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation && pgErr.ConstraintName == "identities_pkey" {
		return fmt.Errorf("%w: %s/%s", account.ErrIdentityExists, ident.Provider, ident.Subject)
	}
	return err
}

func (r identities) UpdateEmail(ctx context.Context, provider, subject string, email *string, verified bool) error {
	_, err := r.q.Exec(ctx,
		`UPDATE auth.identities
		    SET email = $3, email_verified = $4
		  WHERE provider = $1 AND subject = $2`,
		provider, subject, email, verified,
	)
	return err
}

func (r identities) FindUserByVerifiedEmail(ctx context.Context, email string) (uuid.UUID, error) {
	var uid uuid.UUID
	err := r.q.QueryRow(ctx,
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

func (r identities) ListForUser(ctx context.Context, userID uuid.UUID) ([]account.Identity, error) {
	rows, err := r.q.Query(ctx,
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
	var out []account.Identity
	for rows.Next() {
		var i account.Identity
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

func (r identities) LatestVerifiedEmail(ctx context.Context, userID uuid.UUID) (*string, error) {
	var email *string
	err := r.q.QueryRow(ctx,
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
