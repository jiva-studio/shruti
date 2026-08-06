// Package logging wires slog's JSON handler with the base fields the log
// pipeline auto-parses (service / env / version / level / timestamp / message),
// plus per-request request_id pulled off the context.
//
// Use Setup() once at boot, then call slog.InfoContext / slog.ErrorContext
// everywhere else. Mirrors services/orchestrator/internal/logging.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime/debug"
)

// Context keys for per-request fields injected by HTTP middleware.
type ctxKey struct{ name string }

var (
	requestIDKey = ctxKey{"request_id"}
	runIDKey     = ctxKey{"run_id"}
)

// WithRunID marks a context as belonging to one pass over a source, so the
// lines two concurrent runs write can be told apart. A scheduled visit has no
// run, which is why this is separate from the request id.
func WithRunID(ctx context.Context, id int64) context.Context {
	return context.WithValue(ctx, runIDKey, id)
}

// Recovered turns a panic into a log line and lets the caller carry on.
//
// Deferred around one unit of work — one page, one run — it is the difference
// between losing that unit and losing the process, which in a service that
// spends its life inside other people's HTML is not a remote possibility.
func Recovered(ctx context.Context, what string) {
	if r := recover(); r != nil {
		Panicked(ctx, what, r)
	}
}

// Panicked logs a panic the caller has already recovered, for the places that
// need the recovered value themselves — to turn it into an error, or to count
// it. Calling Recovered there would not work: recover only answers once.
func Panicked(ctx context.Context, what string, r any) {
	slog.ErrorContext(ctx, "panic_recovered",
		"in", what, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
}

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
	SetupTo(os.Stdout, serviceName, env, version)
}

// SetupTo sends the log elsewhere. The subcommands that print a result to
// stdout log to stderr instead, so their output stays machine-readable.
func SetupTo(w io.Writer, serviceName, env, version string) {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{
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
