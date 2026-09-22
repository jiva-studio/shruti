package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientIP_IgnoresForwardedHeaderFromAnUntrustedPeer(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/anonymous", nil)
	r.RemoteAddr = "203.0.113.9:4444"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("clientIP = %q, want the socket address", got)
	}
}

func TestClientIP_TakesRightmostHopBehindOurProxy(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/anonymous", nil)
	r.RemoteAddr = "172.18.0.5:3333"
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.9")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("clientIP = %q, want 203.0.113.9", got)
	}
}

// Rotating the client-supplied hop must not hand out a fresh bucket.
func TestClientIP_SpoofedHopCannotChangeTheKey(t *testing.T) {
	key := func(xff string) string {
		r := httptest.NewRequest(http.MethodPost, "/auth/anonymous", nil)
		r.RemoteAddr = "172.18.0.5:1111"
		r.Header.Set("X-Forwarded-For", xff)
		return clientIP(r)
	}
	if key("9.9.9.9, 203.0.113.9") != key("8.8.8.8, 203.0.113.9") {
		t.Fatal("rotating the client-supplied hop changed the limiter key")
	}
}
