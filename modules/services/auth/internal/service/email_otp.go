package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/mail"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/providers"
)

// OTP knobs. Held as consts (not config) — they're security parameters,
// not per-deployment tunables. TTL is generous enough for slow inboxes;
// the attempt cap + resend cooldown bound brute force and email flooding.
const (
	otpCodeTTL        = 10 * time.Minute
	otpResendCooldown = 60 * time.Second
	otpMaxAttempts    = 5
	otpCodeDigits     = 6
)

var (
	// ErrEmailInvalid — the supplied address isn't a syntactically valid email.
	ErrEmailInvalid = errors.New("invalid email")
	// ErrEmailDisabled — no mail transport is configured, so OTP can't be sent.
	ErrEmailDisabled = errors.New("email sign-in is not configured")
	// ErrOTPThrottled — a code was sent too recently; honour the resend cooldown.
	ErrOTPThrottled = errors.New("otp requested too recently")
	// ErrOTPInvalid — wrong, expired, or already-consumed code. Deliberately
	// one error for all three so the handler can't leak which it was.
	ErrOTPInvalid = errors.New("invalid or expired code")
)

// RequestEmailOTP mints a one-time code for the email, stores its hash, and
// sends it. Unified signup+login: any syntactically valid address gets a
// code; whether an account already exists is resolved at verify time.
func (s *Service) RequestEmailOTP(ctx context.Context, rawEmail, locale string) error {
	if s.Emailer == nil || s.EmailOTP == nil {
		return ErrEmailDisabled
	}
	addr, err := normalizeEmail(rawEmail)
	if err != nil {
		return err
	}

	// Durable, multi-instance-safe resend cooldown.
	existing, err := s.EmailOTP.Get(ctx, addr)
	if err != nil {
		return err
	}
	if existing != nil && time.Since(existing.LastSentAt) < otpResendCooldown {
		return ErrOTPThrottled
	}

	code, err := generateNumericCode(otpCodeDigits)
	if err != nil {
		return err
	}
	if err := s.EmailOTP.Upsert(ctx, addr, hashCode(addr, code), time.Now().Add(otpCodeTTL)); err != nil {
		return err
	}
	subject, body := otpEmailContent(code, locale)
	if err := s.Emailer.Send(ctx, addr, subject, body); err != nil {
		return fmt.Errorf("send otp email: %w", err)
	}
	return nil
}

// VerifyEmailOTP checks the code and, on success, resolves-or-creates the
// account (reusing the social sign-in tree with a verified email identity)
// and issues a session. The code is consumed on success and after the
// attempt cap is hit.
func (s *Service) VerifyEmailOTP(ctx context.Context, rawEmail, code string, in SocialInput) (*Session, error) {
	if s.EmailOTP == nil {
		return nil, ErrEmailDisabled
	}
	addr, err := normalizeEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	// Atomically claim one attempt. The check (exists, not expired, under
	// the cap) and the increment happen under a single row lock, so a burst
	// of concurrent verifies can't collectively beat the attempt cap.
	codeHash, ok, err := s.EmailOTP.ConsumeAttempt(ctx, addr, otpMaxAttempts)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrOTPInvalid
	}
	want := hashCode(addr, strings.TrimSpace(code))
	if subtle.ConstantTimeCompare([]byte(want), []byte(codeHash)) != 1 {
		// The attempt was already counted by ConsumeAttempt.
		return nil, ErrOTPInvalid
	}

	// Correct code → consume, then resolve-or-create. The OTP itself is the
	// proof of email ownership, so the synthesized identity is verified. The
	// identity Subject is a hash of the email (not the address itself) — the
	// raw address only ever lives in the policy-gated `email` column, never
	// in the JWT `ids[].s` claim or /auth/me's subject.
	if err := s.EmailOTP.Delete(ctx, addr); err != nil {
		return nil, err
	}
	ident := &providers.Identity{
		Subject:       emailSubject(addr),
		Email:         addr,
		EmailVerified: true,
	}
	return s.signinSocial(ctx, ProviderEmail, ident, in)
}

// normalizeEmail validates and lower-cases the address. ParseAddress also
// tolerates a display-name form; we keep only the bare address.
func normalizeEmail(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrEmailInvalid
	}
	a, err := mail.ParseAddress(raw)
	if err != nil {
		return "", ErrEmailInvalid
	}
	return strings.ToLower(a.Address), nil
}

// generateNumericCode returns an n-digit code from a CSPRNG.
func generateNumericCode(n int) (string, error) {
	const digits = "0123456789"
	b := make([]byte, n)
	for i := range b {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			return "", err
		}
		b[i] = digits[idx.Int64()]
	}
	return string(b), nil
}

// hashCode binds the code to the email so a leaked hash row can't be
// replayed against a different address.
func hashCode(email, code string) string {
	sum := sha256.Sum256([]byte(email + ":" + code))
	return hex.EncodeToString(sum[:])
}

// emailSubject is the stable, non-PII identity subject for the email
// provider: sha256 of the normalized address. Using a hash (not the raw
// email) keeps the cleartext address out of the JWT `ids[].s` claim and
// /auth/me's subject, and out of the RU profile where email is suppressed —
// while still being deterministic so re-login resolves the same identity.
func emailSubject(email string) string {
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:])
}

// otpTemplate is a localized email. %s is the code.
type otpTemplate struct {
	subject string
	bodyFmt string
}

// otpTemplates covers the maintained locale set; everything else (the app's
// other UI languages) falls back to English. Keyed by lower-cased locale.
var otpTemplates = map[string]otpTemplate{
	"en": {
		"Your Shruti sign-in code",
		"Your sign-in code is %s\n\nIt expires in 10 minutes. If you didn't request it, you can safely ignore this email.",
	},
	"ru": {
		"Ваш код для входа в Shruti",
		"Ваш код для входа: %s\n\nКод действителен 10 минут. Если вы не запрашивали его, просто проигнорируйте это письмо.",
	},
	"uk": {
		"Ваш код для входу в Shruti",
		"Ваш код для входу: %s\n\nКод дійсний 10 хвилин. Якщо ви не запитували його, просто проігноруйте цей лист.",
	},
	"sr-latn": {
		"Vaš kod za prijavu na Shruti",
		"Vaš kod za prijavu je %s\n\nVaži 10 minuta. Ako ga niste tražili, slobodno zanemarite ovu poruku.",
	},
	"sr-cyrl": {
		"Ваш код за пријаву на Shruti",
		"Ваш код за пријаву је %s\n\nВажи 10 минута. Ако га нисте тражили, слободно занемарите ову поруку.",
	},
}

// otpEmailContent renders the code email for the requester's locale. Match is
// exact lower-case first (so sr-latn/sr-cyrl pick the right script), then the
// language prefix before "-", then English.
func otpEmailContent(code, locale string) (subject, body string) {
	t := resolveOTPTemplate(locale)
	return t.subject, fmt.Sprintf(t.bodyFmt, code)
}

func resolveOTPTemplate(locale string) otpTemplate {
	l := strings.ToLower(strings.TrimSpace(locale))
	if t, ok := otpTemplates[l]; ok {
		return t
	}
	if i := strings.IndexByte(l, '-'); i > 0 {
		if t, ok := otpTemplates[l[:i]]; ok {
			return t
		}
	}
	return otpTemplates["en"]
}
