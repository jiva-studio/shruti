// Package logging wires slog's JSON handler with the base fields the log
// pipeline parses: service, env, version, level, timestamp and message, plus
// request_id, user_id and run_id taken from the context of each call.
//
// Setup is called once at boot; everything else logs through
// slog.InfoContext / slog.ErrorContext with the request's context.
//
// The field names are a contract with the dashboards and alerts in
// infra/observability: renaming one silently empties a panel.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime/debug"
)

type ctxKey struct{ name string }

var (
	requestIDKey = ctxKey{"request_id"}
	userIDKey    = ctxKey{"user_id"}
	runIDKey     = ctxKey{"run_id"}
)

// WithRequestID returns a context whose log lines carry request_id.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// WithUserID returns a context whose log lines carry the authenticated
// user_id.
func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, userIDKey, id)
}

// WithRunID returns a context whose log lines carry run_id, the one pass of
// background work they belong to.
func WithRunID(ctx context.Context, id int64) context.Context {
	return context.WithValue(ctx, runIDKey, id)
}

// Recovered is deferred at the top of a goroutine: it turns a panic into one
// panic_recovered log line instead of a crashed process.
func Recovered(ctx context.Context, what string) {
	if r := recover(); r != nil {
		Panicked(ctx, what, r)
	}
}

// Panicked logs a value already recovered, with the stack that raised it.
func Panicked(ctx context.Context, what string, r any) {
	slog.ErrorContext(ctx, "panic_recovered",
		"in", what, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
}

// Setup installs, as slog.Default, a JSON logger on stdout carrying service,
// env and version on every line.
func Setup(serviceName, env, version string) {
	SetupTo(os.Stdout, serviceName, env, version)
}

// SetupTo is Setup writing to w.
func SetupTo(w io.Writer, serviceName, env, version string) {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// The pipeline's standard attributes are "message" and
			// "timestamp", not slog's "msg" and "time".
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			if a.Key == slog.TimeKey {
				a.Key = "timestamp"
			}
			return a
		},
	})
	slog.SetDefault(slog.New(&ctxAwareHandler{
		Handler: base.WithAttrs([]slog.Attr{
			slog.String("service", serviceName),
			slog.String("env", env),
			slog.String("version", version),
		}),
	}))
}

// ctxAwareHandler adds the request-scoped fields found on the context of each
// call.
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
	if v, ok := ctx.Value(runIDKey).(int64); ok && v != 0 {
		r.AddAttrs(slog.Int64("run_id", v))
	}
	return h.Handler.Handle(ctx, r)
}

func (h *ctxAwareHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *ctxAwareHandler) WithGroup(name string) slog.Handler {
	return &ctxAwareHandler{Handler: h.Handler.WithGroup(name)}
}
