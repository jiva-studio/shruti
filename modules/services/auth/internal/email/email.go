// Package email sends transactional mail (currently just passwordless
// sign-in OTP codes). The SMTP transport works with AWS SES SMTP
// credentials or any other provider — no cloud SDK dependency, just the
// stdlib net/smtp. A log-only sender is provided for local dev so the
// code can be read from the service logs without wiring real mail.
package email

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
)

// Sender delivers a transactional email. `text` is the plain-text body;
// `html` is an optional HTML alternative (empty → text/plain only).
// Implementations are safe for concurrent use.
type Sender interface {
	Send(ctx context.Context, to, subject, text, html string) error
}

// SMTPConfig configures the SMTP transport. Port 587 (STARTTLS) is the
// expected setup for AWS SES SMTP; net/smtp negotiates STARTTLS
// automatically when the server advertises it.
type SMTPConfig struct {
	Host     string
	Port     string
	Username string
	Password string
	// From is the sender header, e.g. "Shruti <no-reply@shruti.app>"
	// or a bare address. The envelope sender is derived from it.
	From string
}

type smtpSender struct{ cfg SMTPConfig }

// NewSMTPSender returns a Sender that delivers over SMTP.
func NewSMTPSender(cfg SMTPConfig) Sender { return &smtpSender{cfg: cfg} }

func (s *smtpSender) Send(_ context.Context, to, subject, text, html string) error {
	addr := net.JoinHostPort(s.cfg.Host, s.cfg.Port)
	var auth smtp.Auth
	if s.cfg.Username != "" {
		auth = smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)
	}
	msg := buildMessage(s.cfg.From, to, subject, text, html)
	if err := smtp.SendMail(addr, auth, fromAddr(s.cfg.From), []string{to}, msg); err != nil {
		return fmt.Errorf("smtp send: %w", err)
	}
	return nil
}

type logSender struct{}

// NewLogSender returns a Sender that logs the message instead of sending
// it — for local development only. The OTP code is visible in the logs.
func NewLogSender() Sender { return &logSender{} }

func (logSender) Send(ctx context.Context, to, subject, text, _ string) error {
	slog.WarnContext(ctx, "email_log_sender",
		slog.String("to", to),
		slog.String("subject", subject),
		slog.String("body", text),
	)
	return nil
}

// fromAddr extracts the bare address for the SMTP envelope sender, since
// net/smtp.SendMail rejects a "Name <addr>" form there.
func fromAddr(from string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		return a.Address
	}
	return from
}

// otpAltBoundary delimits the multipart/alternative parts. Our bodies are
// base64-encoded, so the boundary token can never appear in them.
const otpAltBoundary = "==shruti-otp-alt=="

// buildMessage assembles the RFC 5322 message. The Subject is RFC 2047
// encoded and bodies are base64 (Content-Transfer-Encoding: base64) so
// non-ASCII locales (ru/uk/sr) survive regardless of 8BITMIME support. With
// an HTML alternative it's a multipart/alternative (text first, then HTML);
// without, a single text/plain part.
func buildMessage(from, to, subject, text, html string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.BEncoding.Encode("UTF-8", subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")

	if html == "" {
		b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
		b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		b.WriteString(base64Wrap(text))
		return []byte(b.String())
	}

	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + otpAltBoundary + "\"\r\n\r\n")
	writeAltPart(&b, "text/plain", text)
	writeAltPart(&b, "text/html", html)
	b.WriteString("--" + otpAltBoundary + "--\r\n")
	return []byte(b.String())
}

func writeAltPart(b *strings.Builder, contentType, body string) {
	b.WriteString("--" + otpAltBoundary + "\r\n")
	b.WriteString("Content-Type: " + contentType + "; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(base64Wrap(body))
	b.WriteString("\r\n")
}

// base64Wrap base64-encodes s and wraps it at 76 chars per CRLF line (RFC 2045).
func base64Wrap(s string) string {
	enc := base64.StdEncoding.EncodeToString([]byte(s))
	var b strings.Builder
	for i := 0; i < len(enc); i += 76 {
		end := i + 76
		if end > len(enc) {
			end = len(enc)
		}
		b.WriteString(enc[i:end])
		b.WriteString("\r\n")
	}
	return b.String()
}
