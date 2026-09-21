// Package httpx is the HTTP plumbing: middleware, error mapping, and
// the chi router wiring. Handlers are kept thin — actual cut logic
// lives in internal/pipeline.
package httpx

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium-share-audio/internal/logx"
)

// statusRecorder wraps ResponseWriter so the access log can read the
// final status code (handlers may write any time before End).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// RequestMiddleware mints / echoes X-Request-Id, binds a child logger
// into the request context, and emits one http_request line per
// response. Fields match app/main.py:request_logger — method, path,
// status, dur_ms, remote_ip.
//
// `base` is the service logger from logx.New(); the per-request child
// is created via base.With("request_id", id).
func RequestMiddleware(base *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rid := strings.TrimSpace(r.Header.Get("X-Request-Id"))
			if rid == "" {
				// 12-char hex prefix — matches main.py:63 (uuid.uuid4().hex[:12]).
				rid = strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
			}
			w.Header().Set("X-Request-Id", rid)

			log := base.With("request_id", rid)
			ctx := logx.Into(r.Context(), log)

			started := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(ctx))

			log.Info(
				"http_request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"dur_ms", time.Since(started).Milliseconds(),
				"remote_ip", clientIP(r),
			)
		})
	}
}

// Recoverer catches panics from downstream handlers, logs the stack via
// slog, and returns a 500 JSON envelope. Without this Go's default
// recoverer prints a non-JSON traceback that breaks Datadog ingest.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		defer func() {
			if rv := recover(); rv != nil {
				log := logx.From(ctx)
				log.Error("panic", "err", rv)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"detail":"internal server error"}`))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
