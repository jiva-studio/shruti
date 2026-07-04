package mcpsrv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
)

type ctxKey int

const clientHashKey ctxKey = iota

// InjectClientHash is an mcp-go HTTP/SSE context func: it derives a stable,
// non-reversible client identifier from the request and stores it in the
// context the tool handlers receive. We hash the IP (never log the raw one).
func InjectClientHash(ctx context.Context, r *http.Request) context.Context {
	return context.WithValue(ctx, clientHashKey, hashClient(r))
}

// ClientHash returns the hashed client id for a tool call, or "anonymous".
func ClientHash(ctx context.Context) string {
	if v, ok := ctx.Value(clientHashKey).(string); ok && v != "" {
		return v
	}
	return "anonymous"
}

func hashClient(r *http.Request) string {
	ip := clientIP(r)
	if ip == "" {
		return "anonymous"
	}
	sum := sha256.Sum256([]byte("corpus-mcp|" + ip))
	return hex.EncodeToString(sum[:])[:16]
}

func clientIP(r *http.Request) string {
	// Behind the reverse proxy the real client is the first X-Forwarded-For hop.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return strings.TrimSpace(xr)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
