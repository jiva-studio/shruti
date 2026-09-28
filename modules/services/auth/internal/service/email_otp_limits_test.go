package service

import (
	"context"
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

// TestEmailOTP_ResendDoesNotRestoreDailyAttempts: requesting a new code
// resets the per-code attempt count but not the per-email daily count, so
// resending cannot turn 5 guesses per code into unlimited guesses.
func TestEmailOTP_ResendDoesNotRestoreDailyAttempts(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "resend-brute@example.com"

	for round := 0; round < otpDailyAttempts/otpMaxAttempts; round++ {
		requestCode(t, svc, cs, addr)
		for i := 0; i < otpMaxAttempts; i++ {
			if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", SocialInput{}); err != ErrOTPInvalid {
				t.Fatalf("round %d attempt %d: want ErrOTPInvalid, got %v", round, i, err)
			}
		}
		ageLastSent(t, svc, addr)
	}
	code := requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, SocialInput{}); err != ErrOTPInvalid {
		t.Fatalf("correct code after %d wrong guesses in 24h: want ErrOTPInvalid, got %v", otpDailyAttempts, err)
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
	code = requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, SocialInput{}); err != ErrOTPInvalid {
		t.Fatalf("correct code after sweep: want ErrOTPInvalid, got %v", err)
	}

	// Once the 24h window has passed the address can sign in again.
	if _, err := svc.Pool.Exec(ctx,
		`UPDATE auth.email_otps SET attempts_window_started_at = now() - interval '25 hours' WHERE email = $1`, addr,
	); err != nil {
		t.Fatalf("age window: %v", err)
	}
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, SocialInput{}); err != nil {
		t.Fatalf("correct code after the window: %v", err)
	}
}

// TestEmailOTP_ResendRestoresPerCodeAttempts: a user who mistypes a code
// five times can request a new one and still sign in.
func TestEmailOTP_ResendRestoresPerCodeAttempts(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()
	const addr = "typo@example.com"

	requestCode(t, svc, cs, addr)
	for i := 0; i < otpMaxAttempts; i++ {
		if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", SocialInput{}); err != ErrOTPInvalid {
			t.Fatalf("attempt %d: want ErrOTPInvalid, got %v", i, err)
		}
	}
	ageLastSent(t, svc, addr)
	code := requestCode(t, svc, cs, addr)
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, SocialInput{}); err != nil {
		t.Fatalf("correct fresh code: %v", err)
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
			case ErrOTPThrottled:
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
