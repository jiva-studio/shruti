package handler

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	logpkg "github.com/jiva-studio/lectorium/analytics/internal/logging"
)

// requestLogger mints/propagates a request id and logs one line per response.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = newRequestID()
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

// newRequestID returns a random 128-bit hex id (no external uuid dep).
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "req"
	}
	return hex.EncodeToString(b[:])
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
