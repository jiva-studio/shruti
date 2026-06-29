package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	logpkg "github.com/jiva-studio/lectorium/billing/internal/logging"
)

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
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return host
}

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, prefix))
}

// tokenBucket is a simple per-key in-memory rate limiter used to cap checkout
// attempts per user/IP. In-memory is fine here: checkout is low-frequency and a
// sidecar instance not seeing another's recent hit just lets one extra request
// through — well below any abuse threshold.
type tokenBucket struct {
	mu       sync.Mutex
	capacity float64
	refill   float64 // tokens per second
	now      func() time.Time
	buckets  map[string]*bucketState
}

type bucketState struct {
	tokens float64
	last   time.Time
}

func newTokenBucket(capacity, refillPerSec float64) *tokenBucket {
	return &tokenBucket{
		capacity: capacity,
		refill:   refillPerSec,
		now:      time.Now,
		buckets:  make(map[string]*bucketState),
	}
}

func (b *tokenBucket) allow(key string) bool {
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	st, ok := b.buckets[key]
	if !ok {
		b.buckets[key] = &bucketState{tokens: b.capacity - 1, last: now}
		return true
	}
	elapsed := now.Sub(st.last).Seconds()
	st.tokens += elapsed * b.refill
	if st.tokens > b.capacity {
		st.tokens = b.capacity
	}
	st.last = now
	if st.tokens < 1 {
		return false
	}
	st.tokens--
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
