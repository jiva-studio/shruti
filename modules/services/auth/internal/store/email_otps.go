package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EmailOTP is one pending passwordless sign-in code. CodeHash is the
// sha256 of email+code — the plaintext code only ever lives in the email.
type EmailOTP struct {
	Email      string
	CodeHash   string
	ExpiresAt  time.Time
	Attempts   int
	LastSentAt time.Time
}

type EmailOTPRepo struct{ Pool *pgxpool.Pool }

// Upsert stores a fresh code for the email, resetting the attempt counter
// and the resend clock. There is at most one active code per address — a
// new request supersedes the previous one.
func (r *EmailOTPRepo) Upsert(ctx context.Context, email, codeHash string, expiresAt time.Time) error {
	_, err := r.Pool.Exec(ctx,
		`INSERT INTO auth.email_otps (email, code_hash, expires_at, attempts, last_sent_at)
		      VALUES ($1, $2, $3, 0, now())
		 ON CONFLICT (email) DO UPDATE
		      SET code_hash    = EXCLUDED.code_hash,
		          expires_at   = EXCLUDED.expires_at,
		          attempts     = 0,
		          last_sent_at = now()`,
		email, codeHash, expiresAt,
	)
	return err
}

// Get returns the pending code for an email, or nil when none exists.
func (r *EmailOTPRepo) Get(ctx context.Context, email string) (*EmailOTP, error) {
	o := &EmailOTP{}
	err := r.Pool.QueryRow(ctx,
		`SELECT email, code_hash, expires_at, attempts, last_sent_at
		   FROM auth.email_otps
		  WHERE email = $1`,
		email,
	).Scan(&o.Email, &o.CodeHash, &o.ExpiresAt, &o.Attempts, &o.LastSentAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return o, nil
}

// ConsumeAttempt atomically claims one verification attempt: it increments
// the counter and returns the stored hash ONLY when a live attempt slot is
// available (row exists, not expired, under maxAttempts). The single UPDATE
// holds a row lock, so concurrent verifies can't each read attempts=0 and
// collectively exceed the cap. `ok == false` means no slot — wrong/expired/
// consumed/over-cap, all indistinguishable to the caller by design.
func (r *EmailOTPRepo) ConsumeAttempt(ctx context.Context, email string, maxAttempts int) (codeHash string, ok bool, err error) {
	err = r.Pool.QueryRow(ctx,
		`UPDATE auth.email_otps
		    SET attempts = attempts + 1
		  WHERE email = $1 AND expires_at > now() AND attempts < $2
		 RETURNING code_hash`,
		email, maxAttempts,
	).Scan(&codeHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return codeHash, true, nil
}

// Delete consumes the code (on success or after the attempt cap).
func (r *EmailOTPRepo) Delete(ctx context.Context, email string) error {
	_, err := r.Pool.Exec(ctx, `DELETE FROM auth.email_otps WHERE email = $1`, email)
	return err
}

// DeleteExpired removes rows past their TTL. Codes are normally consumed on
// verify, but a requested-and-never-used code leaves a row behind; a periodic
// sweep keeps the table from accumulating one stale row per such address.
// Returns the number of rows deleted.
func (r *EmailOTPRepo) DeleteExpired(ctx context.Context) (int64, error) {
	tag, err := r.Pool.Exec(ctx, `DELETE FROM auth.email_otps WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
