// Package logging wires slog's JSON handler with the base fields the log
// pipeline auto-parses (service / env / version / level / timestamp / message),
// plus per-request request_id pulled off the context.
//
// Use Setup() once at boot, then call slog.InfoContext / slog.ErrorContext
// everywhere else. Mirrors services/profile/internal/logging.
package logging

import (
	"context"
	"log/slog"
	"os"
)

// Context keys for per-request fields injected by HTTP middleware.
type ctxKey struct{ name string }

var requestIDKey = ctxKey{"request_id"}

// WithRequestID returns a new context carrying the request id that every
// subsequent log line on this context picks up automatically.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDFromContext is a public read accessor.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// Setup builds a JSON slog logger with service/env/version always present, plus
// a handler that walks the context for the request id above.
func Setup(serviceName, env, version string) {
	base := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			if a.Key == slog.TimeKey {
				a.Key = "timestamp"
			}
			return a
		},
	})
	h := &ctxAwareHandler{
		Handler: base.WithAttrs([]slog.Attr{
			slog.String("service", serviceName),
			slog.String("env", env),
			slog.String("version", version),
		}),
	}
	slog.SetDefault(slog.New(h))
}

// ctxAwareHandler decorates an inner handler by extracting structured fields
// from the request context.
type ctxAwareHandler struct {
	slog.Handler
}

func (h *ctxAwareHandler) Handle(ctx context.Context, r slog.Record) error {
	if v, ok := ctx.Value(requestIDKey).(string); ok && v != "" {
		r.AddAttrs(slog.String("request_id", v))
	}
	return h.Handler.Handle(ctx, r)
}

func (h *ctxAwareHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *ctxAwareHandler) WithGroup(name string) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithGroup(name)}
}
