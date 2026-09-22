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

// clientIP identifies the peer for rate limiting. X-Forwarded-For is a list
// the caller can start — each proxy appends what it saw — so it is read only
// when the direct peer is one of ours, and then only its rightmost entry.
func clientIP(r *http.Request) string {
	peer := remoteHost(r)
	if !isTrustedProxy(peer) {
		return peer
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
			return last
		}
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		return xr
	}
	return peer
}

func remoteHost(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// isTrustedProxy reports whether the direct peer is one of our own hops.
func isTrustedProxy(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}
