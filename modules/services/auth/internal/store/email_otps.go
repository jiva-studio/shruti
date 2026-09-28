package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EmailOTPRepo stores pending passwordless sign-in codes, one row per
// address. code_hash is the sha256 of email+code — the plaintext code only
// ever lives in the email. The row also carries the address's rolling 24h
// verify-attempt count, which outlives individual codes.
type EmailOTPRepo struct{ Pool *pgxpool.Pool }

// attemptWindow is the length of the per-address attempt window.
const attemptWindow = "24 hours"

// windowClosed is true when no attempt window is open for the row.
const windowClosed = `(auth.email_otps.attempts_window_started_at IS NULL
	OR auth.email_otps.attempts_window_started_at <= now() - interval '` + attemptWindow + `')`

// UpsertIfCooledDown stores a fresh code for the email unless one was sent
// less than `cooldown` ago; the check and the write are one statement, so
// concurrent requests for one address store (and send) one code. A new code
// supersedes the previous one and resets its per-code attempt count; the
// per-address attempt window is left as it is. Returns false when throttled.
func (r *EmailOTPRepo) UpsertIfCooledDown(ctx context.Context, email, codeHash string, expiresAt time.Time, cooldown time.Duration) (bool, error) {
	var stored bool
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO auth.email_otps (email, code_hash, expires_at, attempts, code_attempts, last_sent_at)
		      VALUES ($1, $2, $3, 0, 0, now())
		 ON CONFLICT (email) DO UPDATE
		      SET code_hash     = EXCLUDED.code_hash,
		          expires_at    = EXCLUDED.expires_at,
		          code_attempts = 0,
		          last_sent_at  = now()
		    WHERE auth.email_otps.last_sent_at <= now() - make_interval(secs => $4)
		 RETURNING true`,
		email, codeHash, expiresAt, cooldown.Seconds(),
	).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return stored, err
}

// ConsumeAttempt atomically claims one verification attempt and returns the
// stored hash only when a slot is available: the code exists and is not
// expired, the code has fewer than maxPerCode attempts, and the address has
// fewer than maxPerWindow attempts in its open 24h window (a closed window
// restarts at this attempt). One UPDATE holds the row lock, so concurrent
// verifies cannot collectively exceed either cap. `ok == false` means no
// slot — wrong/expired/consumed/over-cap, indistinguishable by design.
func (r *EmailOTPRepo) ConsumeAttempt(ctx context.Context, email string, maxPerCode, maxPerWindow int) (codeHash string, ok bool, err error) {
	err = r.Pool.QueryRow(ctx,
		`UPDATE auth.email_otps
		    SET code_attempts = COALESCE(code_attempts, attempts) + 1,
		        attempts = CASE WHEN `+windowClosed+` THEN 1 ELSE attempts + 1 END,
		        attempts_window_started_at = CASE WHEN `+windowClosed+` THEN now()
		                                          ELSE attempts_window_started_at END
		  WHERE email = $1
		    AND expires_at > now()
		    AND COALESCE(code_attempts, attempts) < $2
		    AND (`+windowClosed+` OR attempts < $3)
		 RETURNING code_hash`,
		email, maxPerCode, maxPerWindow,
	).Scan(&codeHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return codeHash, true, nil
}

// Delete consumes the code after a successful verify, together with the
// address's attempt window.
func (r *EmailOTPRepo) Delete(ctx context.Context, email string) error {
	_, err := r.Pool.Exec(ctx, `DELETE FROM auth.email_otps WHERE email = $1`, email)
	return err
}

// DeleteExpired removes rows whose code has expired and whose attempt window
// is closed, so a requested-and-never-used code does not leave a row behind
// forever while an open window keeps counting. Returns the number of rows
// deleted.
func (r *EmailOTPRepo) DeleteExpired(ctx context.Context) (int64, error) {
	tag, err := r.Pool.Exec(ctx,
		`DELETE FROM auth.email_otps WHERE expires_at < now() AND `+windowClosed)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
