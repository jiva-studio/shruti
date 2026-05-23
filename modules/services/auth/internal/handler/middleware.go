package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/akdasa-studios/shruti/auth/internal/jwt"
	logpkg "github.com/akdasa-studios/shruti/auth/internal/logging"
)

type ctxKey int

const (
	ctxKeyUserID ctxKey = iota + 1
)

// requestLogger attaches a fresh request id to every incoming request,
// emits one access-log line per response (method, path, status, dur_ms),
// and exposes the id via the X-Request-Id response header so a Datadog
// log search can be cross-referenced with a mobile client's stored
// network trace.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Honour an inbound X-Request-Id (set by Caddy or a reverse proxy
		// upstream) if present; otherwise mint one. Either way, that id
		// is the join key across services for this request.
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", reqID)
		ctx := logpkg.WithRequestID(r.Context(), reqID)

		// Capture the response status so the access log knows whether
		// we returned a 2xx or an error.
		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(sr, r.WithContext(ctx))

		slog.InfoContext(ctx, "http_request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sr.status,
			"dur_ms", time.Since(start).Milliseconds(),
			"remote_ip", clientIP(r),
		)
	})
}

// statusRecorder snapshots the response status so the post-handler
// access log can include it. Wraps the original ResponseWriter
// transparently — the inner handler doesn't see the indirection.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// clientIP best-effort: trust X-Forwarded-For's first hop when present
// (Caddy sets it for /auth/* upstream), else fall back to RemoteAddr.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return r.RemoteAddr
}

// requireBearer enforces a valid Authorization: Bearer <access-token> header.
// On success, the caller's user id is stashed in the request context
// AND in the log context, so every subsequent log line on this request
// carries `user_id`.
func requireBearer(v *jwt.Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := extractBearer(r)
			if tok == "" {
				writeErr(w, http.StatusUnauthorized, "missing_token", "Authorization header required")
				return
			}
			claims, err := v.Verify(tok)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", err.Error())
				return
			}
			uid, err := claims.UserID()
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", err.Error())
				return
			}
			ctx := context.WithValue(r.Context(), ctxKeyUserID, uid)
			ctx = logpkg.WithUserID(ctx, uid.String())
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractBearer parses the Authorization header. Returns "" if absent or wrong shape.
func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, prefix))
}

// userFromContext returns the user id set by requireBearer.
func userFromContext(ctx context.Context) (uuid.UUID, bool) {
	uid, ok := ctx.Value(ctxKeyUserID).(uuid.UUID)
	return uid, ok
}
