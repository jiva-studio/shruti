// Package logx sets up slog with a pino-compatible JSON shape so the
// existing Datadog/observability dashboards keep working across the Go
// services (auth, share-audio, share-video, social-poster).
//
// Layout: {"timestamp":"2026-…","level":"info","message":"…","service":…,
// "env":…,"version":…,"pid":…, …}
package logx

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"
)

type ctxKey int

const loggerKey ctxKey = iota

// New builds the base logger. Call once at boot, pass it through context.
func New(level, service, env, version string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level:       parseLevel(level),
		ReplaceAttr: replaceAttr,
	})
	return slog.New(h).With(
		"service", service,
		"env", env,
		"version", version,
		"pid", os.Getpid(),
	)
}

// Into stores a request-scoped logger in the context.
func Into(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, l)
}

// From returns the request-scoped logger, falling back to slog.Default.
func From(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

func replaceAttr(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
		// Millisecond precision, UTC, "Z" — matches new Date().toISOString().
		return slog.String("timestamp", a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z"))
	case slog.LevelKey:
		return slog.String("level", strings.ToLower(a.Value.String()))
	case slog.MessageKey:
		return slog.Attr{Key: "message", Value: a.Value}
	}
	return a
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// MillisSince is a small helper for dur_ms fields in access / phase logs.
func MillisSince(t time.Time) int64 {
	return time.Since(t).Milliseconds()
}
