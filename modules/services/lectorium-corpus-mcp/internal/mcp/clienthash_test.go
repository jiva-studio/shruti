package mcpsrv

import (
	"net/http"
	"testing"
)

func req(remote, xff, xrealip string) *http.Request {
	r := &http.Request{Header: http.Header{}, RemoteAddr: remote}
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	if xrealip != "" {
		r.Header.Set("X-Real-IP", xrealip)
	}
	return r
}

// The limiter key must not be something the caller picks: every search spends
// a paid embedding, and a spoofable key is an unlimited quota.
func TestClientIP_IgnoresForwardedHeadersFromAnUntrustedPeer(t *testing.T) {
	got := clientIP(req("203.0.113.9:4444", "1.2.3.4", "5.6.7.8"))
	if got != "203.0.113.9" {
		t.Fatalf("clientIP = %q, want the socket address", got)
	}
}

// Behind our own proxy the rightmost hop is the address that proxy saw;
// everything to its left is whatever the caller sent.
func TestClientIP_TakesRightmostHopBehindOurProxy(t *testing.T) {
	got := clientIP(req("172.18.0.5:3333", "1.2.3.4, 203.0.113.9", ""))
	if got != "203.0.113.9" {
		t.Fatalf("clientIP = %q, want 203.0.113.9", got)
	}
}

func TestClientIP_SpoofedHeaderCannotChangeTheKey(t *testing.T) {
	a := hashClient(req("172.18.0.5:1111", "9.9.9.9, 203.0.113.9", ""))
	b := hashClient(req("172.18.0.5:2222", "8.8.8.8, 203.0.113.9", ""))
	if a != b {
		t.Fatalf("rotating the client-supplied hop changed the key: %s vs %s", a, b)
	}
}

func TestClientIP_FallsBackToSocketWhenProxySendsNothing(t *testing.T) {
	if got := clientIP(req("127.0.0.1:5555", "", "")); got != "127.0.0.1" {
		t.Fatalf("clientIP = %q, want 127.0.0.1", got)
	}
}
