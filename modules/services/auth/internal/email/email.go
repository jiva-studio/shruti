// Package email sends transactional mail (currently just passwordless
// sign-in OTP codes). The SMTP transport works with AWS SES SMTP
// credentials or any other provider — no cloud SDK dependency, just the
// stdlib net/smtp. A log-only sender is provided for local dev so the
// code can be read from the service logs without wiring real mail.
package email

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
)

// Sender delivers a plain-text email. Implementations are safe for
// concurrent use.
type Sender interface {
	Send(ctx context.Context, to, subject, body string) error
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

func (s *smtpSender) Send(_ context.Context, to, subject, body string) error {
	addr := net.JoinHostPort(s.cfg.Host, s.cfg.Port)
	var auth smtp.Auth
	if s.cfg.Username != "" {
		auth = smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)
	}
	msg := buildMessage(s.cfg.From, to, subject, body)
	if err := smtp.SendMail(addr, auth, fromAddr(s.cfg.From), []string{to}, msg); err != nil {
		return fmt.Errorf("smtp send: %w", err)
	}
	return nil
}

type logSender struct{}

// NewLogSender returns a Sender that logs the message instead of sending
// it — for local development only. The OTP code is visible in the logs.
func NewLogSender() Sender { return &logSender{} }

func (logSender) Send(ctx context.Context, to, subject, body string) error {
	slog.WarnContext(ctx, "email_log_sender",
		slog.String("to", to),
		slog.String("subject", subject),
		slog.String("body", body),
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

func buildMessage(from, to, subject, body string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	b.WriteString("\r\n")
	return []byte(b.String())
}
