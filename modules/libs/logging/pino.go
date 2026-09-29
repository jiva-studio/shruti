package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// NewPino builds the logger of share-audio, share-video and social-poster.
// Its lines have pino's shape, which their dashboards parse:
//
//	{"timestamp":"2026-…Z","level":"info","message":"…","service":…,"env":…,"version":…,"pid":…}
//
// The timestamp has millisecond precision in UTC, as JavaScript's
// toISOString() writes it, and the level is lower case. level is one of
// debug, info, warn(ing) or error; anything else means info.
func NewPino(level, service, env, version string) *slog.Logger {
	return NewPinoTo(os.Stdout, level, service, env, version)
}

// NewPinoTo is NewPino writing to w.
func NewPinoTo(w io.Writer, level, service, env, version string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:       parseLevel(level),
		ReplaceAttr: replacePinoAttr,
	})
	return slog.New(h).With(
		"service", service,
		"env", env,
		"version", version,
		"pid", os.Getpid(),
	)
}

type loggerKey struct{}

// Into stores a request-scoped logger in the context.
func Into(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, l)
}

// From returns the request-scoped logger, or slog.Default when there is none.
func From(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

func replacePinoAttr(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
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
