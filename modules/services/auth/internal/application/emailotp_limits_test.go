package application_test

import (
	"context"
	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"sync"
	"sync/atomic"
	"testing"
)

// ageLastSent moves the resend clock past the cooldown so a test can
// request another code without waiting.
func ageLastSent(t *testing.T, svc *Service, email string) {
	t.Helper()
	if _, err := svc.Pool.Exec(t.Context(),
		`UPDATE auth.email_otps SET last_sent_at = now() - interval '2 minutes' WHERE email = $1`, email,
	); err != nil {
		t.Fatalf("age last_sent_at: %v", err)
	}
}

// claimUntilRefused claims attempts on the current code until one is refused
// and returns how many were granted.
func claimUntilRefused(t *testing.T, svc *Service, addr string) int {
	t.Helper()
	for n := 0; n <= maxAttemptsPerCode; n++ {
		_, ok, err := svc.EmailOTP.ConsumeAttempt(t.Context(), addr, maxAttemptsPerCode)
		if err != nil {
			t.Fatalf("consume: %v", err)
		}
		if !ok {
			return n
		}
	}
	t.Fatalf("code still open after %d attempts", maxAttemptsPerCode+1)
	return 0
}

// wrongCode returns a well-formed code that is not code.
func wrongCode(code string) string {
	if code == "000000" {
		return "111111"
	}
	return "000000"
}

// TestEmailOTP_ResendDoesNotRestoreDailyAttempts: requesting a new code
// does not restore the per-email daily count: once it is spent each fresh
// code allows a single guess, so resending cannot turn 5 guesses per code
// into 5 guesses per minute.
func TestEmailOTP_ResendDoesNotRestoreDailyAttempts(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "resend-brute@example.com"

	for round := 0; round < maxAttemptsPerDay/maxAttemptsPerCode; round++ {
		requestCode(t, svc, cs, addr)
		for i := 0; i < maxAttemptsPerCode; i++ {
			if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", signin.Input{}); err != emailotp.ErrOTPInvalid {
				t.Fatalf("round %d attempt %d: want emailotp.ErrOTPInvalid, got %v", round, i, err)
			}
		}
		ageLastSent(t, svc, addr)
	}
	code := requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, wrongCode(code), signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("wrong guess past the daily cap: want emailotp.ErrOTPInvalid, got %v", err)
	}
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("correct code after its one guess: want emailotp.ErrOTPInvalid, got %v", err)
	}

	// The expired-code sweep keeps the daily count while its window is open.
	if _, err := svc.Pool.Exec(ctx,
		`UPDATE auth.email_otps SET expires_at = now() - interval '1 minute' WHERE email = $1`, addr,
	); err != nil {
		t.Fatalf("expire code: %v", err)
	}
	if _, err := svc.EmailOTP.DeleteExpired(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	ageLastSent(t, svc, addr)
	requestCode(t, svc, cs, addr)
	if got := claimUntilRefused(t, svc, addr); got != 1 {
		t.Fatalf("code sent after sweep took %d attempts, want 1", got)
	}

	// Once the 24h window has passed a new code gets its full allowance.
	if _, err := svc.Pool.Exec(ctx,
		`UPDATE auth.email_otps SET attempts_window_started_at = now() - interval '25 hours' WHERE email = $1`, addr,
	); err != nil {
		t.Fatalf("age window: %v", err)
	}
	ageLastSent(t, svc, addr)
	code = requestCode(t, svc, cs, addr)
	for i := 0; i < maxAttemptsPerCode-1; i++ {
		if _, err := svc.VerifyEmailOTP(ctx, addr, wrongCode(code), signin.Input{}); err != emailotp.ErrOTPInvalid {
			t.Fatalf("guess %d after the window: %v", i, err)
		}
	}
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, signin.Input{}); err != nil {
		t.Fatalf("correct code after the window: %v", err)
	}
}

// TestEmailOTP_CodeGetsWhatIsLeftOfTheDailyCap: a code sent with fewer than
// maxAttemptsPerCode left in the window allows only what is left.
func TestEmailOTP_CodeGetsWhatIsLeftOfTheDailyCap(t *testing.T) {
	svc, cs := bootOTP(t)
	const addr = "partial@example.com"
	requestCode(t, svc, cs, addr)
	if _, err := svc.Pool.Exec(t.Context(),
		`UPDATE auth.email_otps SET attempts = $2, attempts_window_started_at = now() WHERE email = $1`,
		addr, maxAttemptsPerDay-2,
	); err != nil {
		t.Fatalf("seed window: %v", err)
	}
	ageLastSent(t, svc, addr)
	requestCode(t, svc, cs, addr)
	if got := claimUntilRefused(t, svc, addr); got != 2 {
		t.Fatalf("code with 2 attempts left in the window took %d, want 2", got)
	}
}

// TestEmailOTP_ResendRestoresPerCodeAttempts: a user who mistypes a code
// five times can request a new one and still sign in.
func TestEmailOTP_ResendRestoresPerCodeAttempts(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "typo@example.com"

	requestCode(t, svc, cs, addr)
	for i := 0; i < maxAttemptsPerCode; i++ {
		if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", signin.Input{}); err != emailotp.ErrOTPInvalid {
			t.Fatalf("attempt %d: want emailotp.ErrOTPInvalid, got %v", i, err)
		}
	}
	ageLastSent(t, svc, addr)
	code := requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, signin.Input{}); err != nil {
		t.Fatalf("correct fresh code: %v", err)
	}
}

// TestEmailOTP_AttackerCannotLockOutVictim: guesses spent by someone who
// knows the address do not stop its owner from signing in with a code that
// arrives after them.
func TestEmailOTP_AttackerCannotLockOutVictim(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "victim@example.com"
	for round := 0; round < maxAttemptsPerDay/maxAttemptsPerCode; round++ {
		requestCode(t, svc, cs, addr)
		for i := 0; i < maxAttemptsPerCode; i++ {
			if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", signin.Input{}); err != emailotp.ErrOTPInvalid {
				t.Fatalf("attacker guess: %v", err)
			}
		}
		ageLastSent(t, svc, addr)
	}
	code := requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, signin.Input{}); err != nil {
		t.Fatalf("owner's correct code refused after someone else's guesses: %v", err)
	}
}

type countingSender struct{ n atomic.Int64 }

func (c *countingSender) Send(context.Context, string, string, string, string) error {
	c.n.Add(1)
	return nil
}

// TestEmailOTP_ConcurrentRequestsSendOnce: the resend cooldown is decided
// in one statement, so a burst of requests for one address sends one code.
func TestEmailOTP_ConcurrentRequestsSendOnce(t *testing.T) {
	svc, _ := bootOTP(t)
	sender := &countingSender{}
	svc.Emailer = sender

	const n = 10
	var wg sync.WaitGroup
	var throttled atomic.Int64
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch err := svc.RequestEmailOTP(t.Context(), "burst@example.com", ""); err {
			case nil:
			case emailotp.ErrOTPThrottled:
				throttled.Add(1)
			default:
				t.Errorf("request: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := sender.n.Load(); got != 1 {
		t.Fatalf("sent %d codes for one burst, want 1", got)
	}
	if got := throttled.Load(); got != n-1 {
		t.Fatalf("throttled %d requests, want %d", got, n-1)
	}
}
