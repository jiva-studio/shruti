package handler

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/discovery/internal/infra/authjwt"
	logpkg "github.com/jiva-studio/lectorium/discovery/internal/logging"
)

// browsable lets a page in a browser call this service.
//
// A browser needs telling, in a preflight, that it may send a POST carrying
// JSON at all. Without this a client opened from a file never reaches the
// service and the browser reports it as a network failure, which is the one
// explanation that is not true.
//
// Any ORIGIN may ask; that is a different question from who is answered.
// `/discovery/search` still wants a token, and `Authorization` is named in the
// allowed headers so a browser is permitted to send one — a page without one
// gets a 401 it can read rather than a preflight it cannot explain. Nothing
// here grants credentials: no cookies, no Allow-Credentials.
func browsable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", "*")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
			h.Set("Access-Control-Max-Age", "86400")
			h.Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireToken admits a request only if it carries a token this deployment's
// signer issued.
//
// A nil verifier REFUSES. The service is otherwise reached only from inside the
// network, and the one route that isn't reads a corpus and spends an embedding
// on every call; a missing key is a deployment that is not finished, and
// answering anyway would leave that open to anyone who found the address. The
// orchestrator makes the opposite choice for its own gate and says so — there
// the fallback loses a tier check on a route that is already authenticated,
// which is not this.
func requireToken(v *authjwt.Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if v == nil {
				writeErr(w, http.StatusServiceUnavailable, "not_configured",
					"this endpoint requires AUTH_JWT_PUBLIC_KEY_FILE")
				return
			}
			token := bearerToken(r)
			if token == "" {
				writeErr(w, http.StatusUnauthorized, "missing_token", "bearer token required")
				return
			}
			if _, err := v.Verify(token); err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "token verification failed")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// bearerToken pulls the raw JWT from an "Authorization: Bearer <token>" header.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(h) > len(p) && strings.EqualFold(h[:len(p)], p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

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

		args := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", sr.status,
			"dur_ms", time.Since(start).Milliseconds(),
			"remote_ip", clientIP(r),
		}
		// A fault of ours is logged as one; a 4xx is ordinary traffic.
		if sr.status >= http.StatusInternalServerError {
			if sr.errCode != "" {
				args = append(args, "code", sr.errCode, "err", sr.errMsg)
			}
			slog.ErrorContext(ctx, "http_request", args...)
			return
		}
		slog.InfoContext(ctx, "http_request", args...)
	})
}

// statusRecorder carries what the handler answered back out to the logger,
// including why it failed: writeErr tells only the caller.
type statusRecorder struct {
	http.ResponseWriter
	status  int
	errCode string
	errMsg  string
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return r.RemoteAddr
}
