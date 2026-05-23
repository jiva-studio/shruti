package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jiva-studio/shruti-share-video/internal/logx"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// RequestMiddleware mints / echoes X-Request-Id, binds a child slog
// logger into the request context, and emits one http_request line
// per response. Matches the field set pino-http used on the Node side
// (method/path/status/dur_ms/remote_ip) so Datadog dashboards keep
// working.
func RequestMiddleware(base *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rid := strings.TrimSpace(r.Header.Get("X-Request-Id"))
			if rid == "" {
				rid = newRequestID()
			}
			w.Header().Set("X-Request-Id", rid)

			log := base.With("request_id", rid)
			ctx := logx.Into(r.Context(), log)

			started := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(ctx))

			// Attach user_id if RequireAuth set it before this defer runs;
			// for non-auth routes the field is omitted.
			attrs := []any{
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"dur_ms", time.Since(started).Milliseconds(),
				"remote_ip", clientIP(r),
			}
			if u, ok := UserFrom(r.Context()); ok {
				attrs = append(attrs, "user_id", u.ID)
			}
			log.Info("http_request", attrs...)
		})
	}
}

// Recoverer turns handler panics into JSON 500s instead of Go's
// plaintext stack trace that breaks Datadog ingest.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rv := recover(); rv != nil {
				logx.From(r.Context()).Error("panic", "err", rv)
				writeError(w, http.StatusInternalServerError, "internal server error")
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

// newRequestID returns a 16-char hex prefix. Inline so we don't
// depend on uuid here.
func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
