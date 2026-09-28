package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// emailCodes stores pending passwordless sign-in codes, one row per
// address. code_hash is the sha256 of email+code — the plaintext code only
// ever lives in the email. The row also carries the address's rolling 24h
// verify-attempt count, which outlives individual codes.
type emailCodes struct{ q querier }

// attemptWindow is the length of the per-address attempt window.
const attemptWindow = "24 hours"

// windowClosed is true when no attempt window is open for the row.
const windowClosed = `(auth.email_otps.attempts_window_started_at IS NULL
	OR auth.email_otps.attempts_window_started_at <= now() - interval '` + attemptWindow + `')`

// UpsertIfCooledDown stores a fresh code for the email unless one was sent
// less than `cooldown` ago; the check and the write are one statement, so
// concurrent requests for one address store (and send) one code. A new code
// supersedes the previous one; the per-address attempt window is left as it
// is. The code gets what is left of the window's maxPerWindow attempts, at
// most maxPerCode and never fewer than one: a code sent after the cap was
// reached still verifies once, so guesses by someone who cannot read the
// mailbox never lock its owner out. Returns false when throttled.
func (r emailCodes) UpsertIfCooledDown(ctx context.Context, email, codeHash string, expiresAt time.Time, cooldown time.Duration, maxPerCode, maxPerWindow int) (bool, error) {
	var stored bool
	err := r.q.QueryRow(ctx,
		`INSERT INTO auth.email_otps (email, code_hash, expires_at, attempts, code_attempts, last_sent_at)
		      VALUES ($1, $2, $3, 0, 0, now())
		 ON CONFLICT (email) DO UPDATE
		      SET code_hash     = EXCLUDED.code_hash,
		          expires_at    = EXCLUDED.expires_at,
		          code_attempts = CASE WHEN `+windowClosed+` THEN 0
		                               ELSE $5 - GREATEST(1, LEAST($5, $6 - auth.email_otps.attempts)) END,
		          last_sent_at  = now()
		    WHERE auth.email_otps.last_sent_at <= now() - make_interval(secs => $4)
		 RETURNING true`,
		email, codeHash, expiresAt, cooldown.Seconds(), maxPerCode, maxPerWindow,
	).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return stored, err
}

// ConsumeAttempt atomically claims one verification attempt and returns the
// stored hash only when the code exists, is not expired and has fewer than
// maxPerCode attempts; the window's allowance was folded into the code's
// count when it was sent. Every claim is counted in the address's 24h window
// (a closed window restarts at this attempt). One UPDATE holds the row lock,
// so concurrent verifies cannot exceed the cap. `ok == false` means no slot —
// wrong/expired/consumed/over-cap, indistinguishable by design.
func (r emailCodes) ConsumeAttempt(ctx context.Context, email string, maxPerCode int) (codeHash string, ok bool, err error) {
	err = r.q.QueryRow(ctx,
		`UPDATE auth.email_otps
		    SET code_attempts = COALESCE(code_attempts, attempts) + 1,
		        attempts = CASE WHEN `+windowClosed+` THEN 1 ELSE attempts + 1 END,
		        attempts_window_started_at = CASE WHEN `+windowClosed+` THEN now()
		                                          ELSE attempts_window_started_at END
		  WHERE email = $1
		    AND expires_at > now()
		    AND COALESCE(code_attempts, attempts) < $2
		 RETURNING code_hash`,
		email, maxPerCode,
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
func (r emailCodes) Delete(ctx context.Context, email string) error {
	_, err := r.q.Exec(ctx, `DELETE FROM auth.email_otps WHERE email = $1`, email)
	return err
}

// DeleteExpired removes rows whose code has expired and whose attempt window
// is closed, so a requested-and-never-used code does not leave a row behind
// forever while an open window keeps counting. Returns the number of rows
// deleted.
func (r emailCodes) DeleteExpired(ctx context.Context) (int64, error) {
	tag, err := r.q.Exec(ctx,
		`DELETE FROM auth.email_otps WHERE expires_at < now() AND `+windowClosed)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
