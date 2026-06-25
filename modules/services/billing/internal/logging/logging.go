// Package logging wires slog's JSON handler with the base fields the
// log pipeline auto-parses (service / env / version / level / timestamp /
// message). Mirrors the auth service's logging package.
package logging

import (
	"context"
	"log/slog"
	"os"
)

type ctxKey struct{ name string }

var (
	requestIDKey = ctxKey{"request_id"}
	userIDKey    = ctxKey{"user_id"}
)

func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, userIDKey, id)
}

func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

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
