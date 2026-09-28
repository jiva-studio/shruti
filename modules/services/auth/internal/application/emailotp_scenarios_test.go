package application_test

import (
	"context"
	"regexp"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

// captureSender records the last email it was asked to send so tests can
// read back the OTP code from the body.
type captureSender struct {
	to, subject, body, html string
	sends                   int
}

func (c *captureSender) Send(_ context.Context, to, subject, text, html string) error {
	c.to, c.subject, c.body, c.html = to, subject, text, html
	c.sends++
	return nil
}

var sixDigits = regexp.MustCompile(`\d{6}`)

func bootOTP(t *testing.T) (*Service, *captureSender) {
	t.Helper()
	svc, _ := boot(t)
	cs := &captureSender{}
	svc.Emailer = cs
	return svc, cs
}

// requestCode runs RequestEmailOTP and returns the code captured from the
// sent email.
func requestCode(t *testing.T, svc *Service, cs *captureSender, email string) string {
	t.Helper()
	if err := svc.RequestEmailOTP(t.Context(), email, ""); err != nil {
		t.Fatalf("request otp: %v", err)
	}
	code := sixDigits.FindString(cs.body)
	if code == "" {
		t.Fatalf("no 6-digit code in email body: %q", cs.body)
	}
	return code
}

func TestEmailOTP_NewUserSignsIn(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	code := requestCode(t, svc, cs, "User@Example.com")
	sess, err := svc.VerifyEmailOTP(ctx, "user@example.com", code, signin.Input{DeviceID: "dev-otp-1"})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sess.UserID.String() == "" || sess.Anonymous {
		t.Fatalf("expected a non-anonymous session, got %+v", sess)
	}
	// /me reflects the verified email (global policy collects it).
	me, err := svc.Me(ctx, sess.UserID)
	if err != nil {
		t.Fatalf("me: %v", err)
	}
	if me.Email == nil || *me.Email != "user@example.com" {
		t.Errorf("me email = %v, want user@example.com", me.Email)
	}
}

func TestEmailOTP_ReturningUserSameAccount(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	first, err := svc.VerifyEmailOTP(ctx, "x@example.com", requestCode(t, svc, cs, "x@example.com"), signin.Input{})
	if err != nil {
		t.Fatalf("first verify: %v", err)
	}
	second, err := svc.VerifyEmailOTP(ctx, "x@example.com", requestCode(t, svc, cs, "x@example.com"), signin.Input{})
	if err != nil {
		t.Fatalf("second verify: %v", err)
	}
	if first.UserID != second.UserID {
		t.Errorf("same email should give same user: %s vs %s", first.UserID, second.UserID)
	}
}

func TestEmailOTP_WrongCodeRejected(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	_ = requestCode(t, svc, cs, "y@example.com")
	if _, err := svc.VerifyEmailOTP(ctx, "y@example.com", "000000", signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("want emailotp.ErrOTPInvalid for wrong code, got %v", err)
	}
}

func TestEmailOTP_CodeConsumedAfterUse(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	code := requestCode(t, svc, cs, "z@example.com")
	if _, err := svc.VerifyEmailOTP(ctx, "z@example.com", code, signin.Input{}); err != nil {
		t.Fatalf("verify: %v", err)
	}
	// Re-using the same code must fail — it was consumed.
	if _, err := svc.VerifyEmailOTP(ctx, "z@example.com", code, signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("want emailotp.ErrOTPInvalid on reuse, got %v", err)
	}
}

func TestEmailOTP_ResendThrottled(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	if err := svc.RequestEmailOTP(ctx, "t@example.com", ""); err != nil {
		t.Fatalf("first request: %v", err)
	}
	if err := svc.RequestEmailOTP(ctx, "t@example.com", ""); err != emailotp.ErrOTPThrottled {
		t.Fatalf("want emailotp.ErrOTPThrottled on immediate resend, got %v", err)
	}
	if cs.sends != 1 {
		t.Errorf("throttled resend should not send a second email, sends=%d", cs.sends)
	}
}

func TestEmailOTP_InvalidEmailRejected(t *testing.T) {
	svc, _ := bootOTP(t)
	if err := svc.RequestEmailOTP(t.Context(), "not-an-email", ""); err != emailotp.ErrEmailInvalid {
		t.Fatalf("want emailotp.ErrEmailInvalid, got %v", err)
	}
}

func TestEmailOTP_DisabledWithoutSender(t *testing.T) {
	svc, _ := bootOTP(t)
	svc.Emailer = nil
	if err := svc.RequestEmailOTP(t.Context(), "a@example.com", ""); err != emailotp.ErrEmailDisabled {
		t.Fatalf("want emailotp.ErrEmailDisabled, got %v", err)
	}
}

func TestEmailOTP_SubjectIsHashedNotRawEmail(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	const addr = "privacy@example.com"
	sess, err := svc.VerifyEmailOTP(ctx, addr, requestCode(t, svc, cs, addr), signin.Input{})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	idents, err := svc.Identities.ListForUser(ctx, sess.UserID)
	if err != nil {
		t.Fatalf("list identities: %v", err)
	}
	var found bool
	for _, id := range idents {
		if id.Provider != account.ProviderEmail {
			continue
		}
		found = true
		if id.Subject == addr {
			t.Errorf("identity subject is the raw email (PII leaks into JWT/me): %q", id.Subject)
		}
		if id.Subject != emailSubject(addr) {
			t.Errorf("subject = %q, want %q", id.Subject, emailSubject(addr))
		}
	}
	if !found {
		t.Fatal("no email identity created")
	}
}

func TestEmailOTP_AttemptCapEnforced(t *testing.T) {
	svc, cs := bootOTP(t)
	ctx := t.Context()

	const addr = "bruteforce@example.com"
	code := requestCode(t, svc, cs, addr)
	// Exhaust the attempt cap with wrong guesses.
	for i := 0; i < maxAttemptsPerCode; i++ {
		if _, err := svc.VerifyEmailOTP(ctx, addr, "000000", signin.Input{}); err != emailotp.ErrOTPInvalid {
			t.Fatalf("wrong attempt %d: want emailotp.ErrOTPInvalid, got %v", i, err)
		}
	}
	// Even the CORRECT code is now rejected — the cap was consumed atomically.
	if _, err := svc.VerifyEmailOTP(ctx, addr, code, signin.Input{}); err != emailotp.ErrOTPInvalid {
		t.Fatalf("correct code after cap: want emailotp.ErrOTPInvalid, got %v", err)
	}
}

// Email OTP must land on the SAME account a user already created with a
// social provider sharing the verified email (cross-link), so tier/quota
// stay unified across login methods.
func TestEmailOTP_LinksExistingGoogleByEmail(t *testing.T) {
	svc, stub := boot(t)
	cs := &captureSender{}
	svc.Emailer = cs
	ctx := t.Context()

	stub.Want = account.ProviderIdentity{Subject: "g-sub-1", Email: "linked@example.com", EmailVerified: true}
	gsess, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "x"})
	if err != nil {
		t.Fatalf("google signin: %v", err)
	}

	esess, err := svc.VerifyEmailOTP(ctx, "linked@example.com", requestCode(t, svc, cs, "linked@example.com"), signin.Input{})
	if err != nil {
		t.Fatalf("email verify: %v", err)
	}
	if gsess.UserID != esess.UserID {
		t.Errorf("email OTP should link to the existing Google account: %s vs %s", gsess.UserID, esess.UserID)
	}
}
