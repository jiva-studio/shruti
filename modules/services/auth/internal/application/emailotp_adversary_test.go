package application_test

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

// TestEmailOTP_ConcurrentGuessesAcrossResendsStopAtDailyCap: bursts of
// concurrent verifies, with a fresh code between bursts, claim exactly the
// daily number of attempts plus one per code sent past the cap.
func TestEmailOTP_ConcurrentGuessesAcrossResendsStopAtDailyCap(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "storm@example.com"
	const rounds = 2 * maxAttemptsPerDay / maxAttemptsPerCode
	const pastCap = rounds - maxAttemptsPerDay/maxAttemptsPerCode

	var claimed atomic.Int64
	for round := 0; round < rounds; round++ {
		requestCode(t, svc, cs, addr)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < 3*maxAttemptsPerCode; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, maxAttemptsPerCode)
				if err != nil {
					t.Errorf("consume: %v", err)
					return
				}
				if ok {
					claimed.Add(1)
				}
			}()
		}
		close(start)
		wg.Wait()
		ageLastSent(t, svc, addr)
	}
	if got := claimed.Load(); got != maxAttemptsPerDay+pastCap {
		t.Fatalf("claimed %d attempts in one window, want exactly %d", got, maxAttemptsPerDay+pastCap)
	}
}

// otpHash is the stored hash of a code: sha256 of "email:code", hex.
func otpHash(email, code string) string {
	sum := sha256.Sum256([]byte(email + ":" + code))
	return hex.EncodeToString(sum[:])
}

// insertNullCodeAttemptsOTP writes a row whose code_attempts and
// attempts_window_started_at are NULL, so `attempts` counts guesses against the
// current code.
func insertNullCodeAttemptsOTP(t *testing.T, svc *Service, addr, code string, attempts int, expiresAt time.Time) {
	t.Helper()
	if _, err := svc.Pool.Exec(t.Context(),
		`INSERT INTO auth.email_otps (email, code_hash, expires_at, attempts, last_sent_at)
		      VALUES ($1, $2, $3, $4, now() - interval '5 minutes')`,
		addr, otpHash(addr, code), expiresAt, attempts,
	); err != nil {
		t.Fatalf("insert null-code_attempts row: %v", err)
	}
}

// TestEmailOTP_NullCodeAttemptsRowKeepsItsPerCodeCount: a row with NULL
// code_attempts and three guesses spent has two left, and the address's daily
// window opens on the next attempt.
func TestEmailOTP_NullCodeAttemptsRowKeepsItsPerCodeCount(t *testing.T) {
	svc, _ := bootOTP(t)
	ctx := t.Context()
	const addr = "nullcodes@example.com"
	insertNullCodeAttemptsOTP(t, svc, addr, "123456", 3, time.Now().Add(5*time.Minute))

	for i := 0; i < maxAttemptsPerCode-3; i++ {
		if _, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, maxAttemptsPerCode); err != nil || !ok {
			t.Fatalf("attempt %d: ok=%v err=%v, want a slot", i, ok, err)
		}
	}
	if _, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, maxAttemptsPerCode); err != nil || ok {
		t.Fatalf("attempt past the per-code cap: ok=%v err=%v, want refused", ok, err)
	}
	var attempts int
	var window *time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT attempts, attempts_window_started_at FROM auth.email_otps WHERE email = $1`, addr,
	).Scan(&attempts, &window); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if attempts != maxAttemptsPerCode-3 || window == nil {
		t.Fatalf("daily window after null-code_attempts row: attempts=%d window=%v, want %d and an open window",
			attempts, window, maxAttemptsPerCode-3)
	}
}

// TestEmailOTP_ExhaustedNullCodeAttemptsCodeStaysRefused: a NULL code_attempts
// row that spent all its guesses gets no fresh ones.
func TestEmailOTP_ExhaustedNullCodeAttemptsCodeStaysRefused(t *testing.T) {
	svc, _ := bootOTP(t)
	const addr = "spent@example.com"
	insertNullCodeAttemptsOTP(t, svc, addr, "222222", maxAttemptsPerCode, time.Now().Add(5*time.Minute))
	if _, err := svc.VerifyEmailOTP(t.Context(), addr, "222222", signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("exhausted code: want ErrOTPInvalid, got %v", err)
	}
}

// TestEmailOTP_NullCodeAttemptsRowCodeStillSignsIn: the correct code of a NULL
// code_attempts row verifies, and such a row that expired is swept.
func TestEmailOTP_NullCodeAttemptsRowCodeStillSignsIn(t *testing.T) {
	svc, _ := bootOTP(t)
	ctx := t.Context()
	insertNullCodeAttemptsOTP(t, svc, "ok@example.com", "654321", 4, time.Now().Add(5*time.Minute))
	if _, err := svc.VerifyEmailOTP(ctx, "ok@example.com", "654321", signin.Input{}); err != nil {
		t.Fatalf("code with one guess left: %v", err)
	}

	insertNullCodeAttemptsOTP(t, svc, "stale@example.com", "111111", 0, time.Now().Add(-time.Minute))
	if _, err := svc.EmailOTP.DeleteExpired(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.email_otps WHERE email = 'stale@example.com'`,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("expired row survived the sweep")
	}
}

// TestConcurrentFirstSigninFromOneAnonymousDevice: a burst of first sign-ins
// carrying the same anonymous bearer all upgrade that anonymous user; none
// mints a second account.
func TestConcurrentFirstSigninFromOneAnonymousDevice(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()
	anon, err := svc.Anonymous(ctx, "dev-race", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	stub.Want = account.ProviderIdentity{Subject: "g-anon-race", Email: "anon-race@example.com", EmailVerified: true}

	const n = 12
	var wg sync.WaitGroup
	ids := make(chan uuid.UUID, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			sess, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "stub", DeviceID: "dev-race", BearerAccess: anon.AccessToken})
			if err != nil {
				t.Errorf("sign-in: %v", err)
				return
			}
			ids <- sess.UserID
		}()
	}
	close(start)
	wg.Wait()
	close(ids)
	for id := range ids {
		if id != anon.UserID {
			t.Fatalf("sign-in landed on %s, want the anonymous user %s", id, anon.UserID)
		}
	}
	var users int
	if err := svc.Pool.QueryRow(ctx, `SELECT count(*) FROM auth.users`).Scan(&users); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if users != 1 {
		t.Fatalf("users = %d, want 1", users)
	}
}
