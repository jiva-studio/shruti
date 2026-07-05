package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/jwt"
	logpkg "github.com/jiva-studio/shruti/profile/internal/logging"
)

type ctxKey int

const ctxKeyUserID ctxKey = iota + 1

// requestLogger mints/propagates a request id and logs one line per response.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", reqID)
		ctx := logpkg.WithRequestID(r.Context(), reqID)

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

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return r.RemoteAddr
}

// requireBearer enforces a valid Authorization: Bearer <access-token>. It
// pins audience="chat" (the token both mobile and web clients hold) and
// REJECTS an anonymous token with 403 — only signed-in accounts sync. On
// success the user id is stashed in the request + log context.
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
			if !claims.HasAudience(jwt.AudienceChat) {
				writeErr(w, http.StatusUnauthorized, "invalid_audience", "token audience must include chat")
				return
			}
			// Anonymous accounts do not sync — the client keeps the engine
			// off, and the server enforces it too.
			if claims.Anonymous {
				writeErr(w, http.StatusForbidden, "anonymous_forbidden", "sync requires a signed-in account")
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

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, prefix))
}

func userFromContext(ctx context.Context) (uuid.UUID, bool) {
	uid, ok := ctx.Value(ctxKeyUserID).(uuid.UUID)
	return uid, ok
}
