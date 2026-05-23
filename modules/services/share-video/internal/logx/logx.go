// Package logx wraps log/slog so the on-disk JSON shape matches what
// pino currently emits. Datadog dashboards key on the field names
// below; do not rename them.
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

func Into(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, l)
}

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

// MillisSince is shared sugar for dur_ms / t_ms fields.
func MillisSince(t time.Time) int64 {
	return time.Since(t).Milliseconds()
}
