package service

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/providers"
)

// TestEmailOTP_ConcurrentGuessesAcrossResendsStopAtDailyCap: bursts of
// concurrent verifies, with a fresh code between bursts, claim exactly the
// daily number of attempts and never one more.
func TestEmailOTP_ConcurrentGuessesAcrossResendsStopAtDailyCap(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "storm@example.com"

	var claimed atomic.Int64
	for round := 0; round < 2*otpDailyAttempts/otpMaxAttempts; round++ {
		requestCode(t, svc, cs, addr)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < 3*otpMaxAttempts; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, otpMaxAttempts, otpDailyAttempts)
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
	if got := claimed.Load(); got != otpDailyAttempts {
		t.Fatalf("claimed %d attempts in one window, want exactly %d", got, otpDailyAttempts)
	}
}

// insertLegacyOTP writes a row the way the service stored it before migration
// 0049: `attempts` counts guesses against the current code, and the two new
// columns are NULL.
func insertLegacyOTP(t *testing.T, svc *Service, addr, code string, attempts int, expiresAt time.Time) {
	t.Helper()
	if _, err := svc.Pool.Exec(t.Context(),
		`INSERT INTO auth.email_otps (email, code_hash, expires_at, attempts, last_sent_at)
		      VALUES ($1, $2, $3, $4, now() - interval '5 minutes')`,
		addr, hashCode(addr, code), expiresAt, attempts,
	); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
}

// TestEmailOTP_LegacyRowKeepsItsPerCodeCount: a code issued before 0049 with
// three guesses already spent has two left, and the address's daily window
// opens on the first post-migration attempt.
func TestEmailOTP_LegacyRowKeepsItsPerCodeCount(t *testing.T) {
	svc, _ := bootOTP(t)
	ctx := t.Context()
	const addr = "legacy@example.com"
	insertLegacyOTP(t, svc, addr, "123456", 3, time.Now().Add(5*time.Minute))

	for i := 0; i < otpMaxAttempts-3; i++ {
		if _, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, otpMaxAttempts, otpDailyAttempts); err != nil || !ok {
			t.Fatalf("legacy attempt %d: ok=%v err=%v, want a slot", i, ok, err)
		}
	}
	if _, ok, err := svc.EmailOTP.ConsumeAttempt(ctx, addr, otpMaxAttempts, otpDailyAttempts); err != nil || ok {
		t.Fatalf("attempt past the legacy per-code cap: ok=%v err=%v, want refused", ok, err)
	}
	var attempts int
	var window *time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT attempts, attempts_window_started_at FROM auth.email_otps WHERE email = $1`, addr,
	).Scan(&attempts, &window); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if attempts != otpMaxAttempts-3 || window == nil {
		t.Fatalf("daily window after legacy row: attempts=%d window=%v, want %d and an open window",
			attempts, window, otpMaxAttempts-3)
	}
}

// TestEmailOTP_ExhaustedLegacyCodeStaysRefused: a code that spent all its
// guesses before 0049 gets no fresh ones from the migration.
func TestEmailOTP_ExhaustedLegacyCodeStaysRefused(t *testing.T) {
	svc, _ := bootOTP(t)
	const addr = "legacy-spent@example.com"
	insertLegacyOTP(t, svc, addr, "222222", otpMaxAttempts, time.Now().Add(5*time.Minute))
	if _, err := svc.VerifyEmailOTP(t.Context(), addr, "222222", SocialInput{}); err != ErrOTPInvalid {
		t.Fatalf("exhausted legacy code: want ErrOTPInvalid, got %v", err)
	}
}

// TestEmailOTP_LegacyRowCodeStillSignsIn: the correct legacy code verifies
// after the migration, and a legacy row that expired is swept.
func TestEmailOTP_LegacyRowCodeStillSignsIn(t *testing.T) {
	svc, _ := bootOTP(t)
	ctx := t.Context()
	insertLegacyOTP(t, svc, "legacy-ok@example.com", "654321", 4, time.Now().Add(5*time.Minute))
	if _, err := svc.VerifyEmailOTP(ctx, "legacy-ok@example.com", "654321", SocialInput{}); err != nil {
		t.Fatalf("legacy code with one guess left: %v", err)
	}

	insertLegacyOTP(t, svc, "legacy-stale@example.com", "111111", 0, time.Now().Add(-time.Minute))
	if _, err := svc.EmailOTP.DeleteExpired(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.email_otps WHERE email = 'legacy-stale@example.com'`,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("expired legacy row survived the sweep")
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
	stub.Want = providers.Identity{Subject: "g-anon-race", Email: "anon-race@example.com", EmailVerified: true}

	const n = 12
	var wg sync.WaitGroup
	ids := make(chan uuid.UUID, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			sess, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub", DeviceID: "dev-race", BearerAccess: anon.AccessToken})
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
