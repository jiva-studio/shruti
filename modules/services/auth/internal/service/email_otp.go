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
	subject, text, html := otpEmailContent(code, locale)
	if err := s.Emailer.Send(ctx, addr, subject, text, html); err != nil {
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

// otpTemplate is a localized email. textFmt's %s is the code; htmlLead and
// htmlNote are the two localized lines of the branded HTML version.
type otpTemplate struct {
	subject  string
	textFmt  string
	htmlLead string
	htmlNote string
}

// otpTemplates covers the maintained locale set; everything else (the app's
// other UI languages) falls back to English. Keyed by lower-cased locale.
var otpTemplates = map[string]otpTemplate{
	"en": {
		"Your Shruti sign-in code",
		"Your sign-in code is %s\n\nIt expires in 10 minutes. If you didn't request it, you can safely ignore this email.",
		"Use this code to sign in.",
		"This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.",
	},
	"ru": {
		"Ваш код для входа в Shruti",
		"Ваш код для входа: %s\n\nКод действителен 10 минут. Если вы не запрашивали его, просто проигнорируйте это письмо.",
		"Используйте этот код для входа.",
		"Код действителен 10 минут. Если вы не запрашивали его, просто проигнорируйте это письмо.",
	},
	"uk": {
		"Ваш код для входу в Shruti",
		"Ваш код для входу: %s\n\nКод дійсний 10 хвилин. Якщо ви не запитували його, просто проігноруйте цей лист.",
		"Використайте цей код для входу.",
		"Код дійсний 10 хвилин. Якщо ви не запитували його, просто проігноруйте цей лист.",
	},
	"sr-latn": {
		"Vaš kod za prijavu na Shruti",
		"Vaš kod za prijavu je %s\n\nVaži 10 minuta. Ako ga niste tražili, slobodno zanemarite ovu poruku.",
		"Upotrebite ovaj kod za prijavu.",
		"Kod važi 10 minuta. Ako ga niste tražili, slobodno zanemarite ovu poruku.",
	},
	"sr-cyrl": {
		"Ваш код за пријаву на Shruti",
		"Ваш код за пријаву је %s\n\nВажи 10 минута. Ако га нисте тражили, слободно занемарите ову поруку.",
		"Употребите овај код за пријаву.",
		"Код важи 10 минута. Ако га нисте тражили, слободно занемарите ову поруку.",
	},
}

// otpEmailContent renders the code email for the requester's locale, returning
// the subject plus a plain-text body and a branded HTML body (multipart
// alternative). Match is exact lower-case first (so sr-latn/sr-cyrl pick the
// right script), then the language prefix before "-", then English.
func otpEmailContent(code, locale string) (subject, text, html string) {
	t := resolveOTPTemplate(locale)
	return t.subject, fmt.Sprintf(t.textFmt, code), renderOTPHTML(t.htmlLead, code, t.htmlNote)
}

// Brand assets for the email chrome (logo + contacts footer).
const (
	otpLogoURL      = "https://shruti.app/app-icon.png"
	otpWebsiteURL   = "https://shruti.app"
	otpSupportEmail = "support@jiva.studio"
	otpTelegramURL  = "https://t.me/shrutiapp"
	otpVKURL        = "https://vk.com/shruti"
	otpFeatherURL   = "https://shruti.app/hero-feather.png"
)

// renderOTPHTML builds the branded email in the website's palette (cream
// background #faf5ea, ink #3d2b1f, saffron #cc7a3d, cream-deep code chip
// #f3ede0, line #e8ddc8; serif title). App logo at the top, a contacts footer
// at the bottom. Table layout + inline styles for email client compatibility.
// lead/code/note are trusted (no user input).
func renderOTPHTML(lead, code, note string) string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<style>@import url('https://fonts.googleapis.com/css2?family=Literata:wght@700&family=Manrope:wght@400;600;700&display=swap');</style>` +
		`</head>` +
		`<body style="margin:0;padding:0;background-color:#faf5ea;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf5ea;padding:40px 16px;">` +
		`<tr><td align="center">` +
		`<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background-color:#ffffff;background-image:url('` + otpFeatherURL + `');background-repeat:no-repeat;background-position:bottom -18px right -18px;background-size:130px auto;border:1px solid #e8ddc8;border-radius:16px;padding:36px 32px;">` +
		`<tr><td align="center" style="padding-bottom:14px;"><img src="` + otpLogoURL + `" width="64" height="64" alt="Shruti" style="display:block;border-radius:14px;"></td></tr>` +
		`<tr><td align="center" style="font-family:'Literata',Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#3d2b1f;padding-bottom:8px;">Shruti</td></tr>` +
		`<tr><td align="center" style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;color:#806752;padding-bottom:28px;">` + lead + `</td></tr>` +
		`<tr><td align="center"><div style="display:inline-block;background-color:#f3ede0;border-radius:12px;padding:16px 28px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#cc7a3d;">` + code + `</div></td></tr>` +
		`<tr><td align="center" style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.5;color:#9b8f7e;padding-top:28px;">` + note + `</td></tr>` +
		`<tr><td style="padding-top:28px;"><div style="border-top:1px solid #e8ddc8;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
		`<tr><td align="center" style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#a89e8e;padding-top:16px;line-height:1.7;">` +
		`<a href="` + otpWebsiteURL + `" style="color:#806752;text-decoration:none;">shruti.app</a>` +
		` &nbsp;&middot;&nbsp; <a href="mailto:` + otpSupportEmail + `" style="color:#806752;text-decoration:none;">` + otpSupportEmail + `</a>` +
		` &nbsp;&middot;&nbsp; <a href="` + otpTelegramURL + `" style="color:#806752;text-decoration:none;">Telegram</a>` +
		` &nbsp;&middot;&nbsp; <a href="` + otpVKURL + `" style="color:#806752;text-decoration:none;">VK</a>` +
		`</td></tr>` +
		`</table></td></tr></table></body></html>`
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
