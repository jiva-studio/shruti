// Package logging wires slog's JSON handler with the base fields the
// Datadog log pipeline auto-parses (service / env / version / level /
// timestamp / message).
//
// Use Setup() once at boot, then call slog.InfoContext / slog.ErrorContext
// (or the wrapper helpers in this package) everywhere else.
package logging

import (
	"context"
	"log/slog"
	"os"
)

// Context keys for per-request fields injected by HTTP middleware.
// They're not part of the global logger; the slog.Handler reads them
// off the context for every log call inside the request.
type ctxKey struct{ name string }

var (
	requestIDKey = ctxKey{"request_id"}
	userIDKey    = ctxKey{"user_id"}
)

// WithRequestID returns a new context carrying the request id that
// every subsequent log line on this context picks up automatically.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// WithUserID attaches the authenticated user id (after JWT verify).
func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, userIDKey, id)
}

// RequestIDFromContext is a public read accessor — handlers occasionally
// want to surface the id in HTTP responses or pass it to a downstream.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// Setup builds a JSON slog logger with `service`/`env`/`version` always
// present, plus a custom handler that walks the context for the request
// keys above. Installs it as slog.Default so package-level
// slog.{Info,Warn,Error,Debug}Context calls just work.
func Setup(serviceName, env, version string) {
	base := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// slog's default key is "msg"; Datadog standard attribute is
			// "message". Rename so the log pipeline picks it up cleanly.
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			// "time" → "timestamp" for the same reason.
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

// ctxAwareHandler decorates an inner handler by extracting structured
// fields from the request context. Keeps the request_id / user_id
// plumbing invisible to handler authors.
type ctxAwareHandler struct {
	slog.Handler
}

func (h *ctxAwareHandler) Handle(ctx context.Context, r slog.Record) error {
	if v, ok := ctx.Value(requestIDKey).(string); ok && v != "" {
		r.AddAttrs(slog.String("request_id", v))
	}
	if v, ok := ctx.Value(userIDKey).(string); ok && v != "" {
		r.AddAttrs(slog.String("user_id", v))
	}
	return h.Handler.Handle(ctx, r)
}

func (h *ctxAwareHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *ctxAwareHandler) WithGroup(name string) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithGroup(name)}
}
