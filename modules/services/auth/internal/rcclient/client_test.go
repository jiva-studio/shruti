package rcclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// newTestClient wires a Client against an in-memory test server. APIKey
// is non-empty so the empty-key guard inside GetSubscriber doesn't
// short-circuit before the HTTP call.
func newTestClient(t *testing.T, status int, body string, headers map[string]string) (*Client, func()) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		if body != "" {
			_, _ = w.Write([]byte(body))
		}
	}))
	c := &Client{
		BaseURL: srv.URL,
		APIKey:  "test-key",
		HTTP:    srv.Client(),
	}
	return c, srv.Close
}

// TestGetSubscriber200OK — a normal happy-path response decodes into
// SubscriberResponse and surfaces no error.
func TestGetSubscriber200OK(t *testing.T) {
	body := `{"subscriber":{"entitlements":{"pro":{"product_identifier":"p"}}}}`
	c, cleanup := newTestClient(t, http.StatusOK, body, nil)
	defer cleanup()

	resp, err := c.GetSubscriber(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := resp.Subscriber.Entitlements["pro"]; !ok {
		t.Fatalf("expected entitlement 'pro' in response, got %+v", resp.Subscriber.Entitlements)
	}
}

// TestGetSubscriber404Sentinel — 404 must surface ErrSubscriberNotFound
// (sentinel) AND return a non-nil empty response so callers can apply
// `tier=free` via the same path as a real empty-entitlements body.
func TestGetSubscriber404Sentinel(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusNotFound, `{"code":7259}`, nil)
	defer cleanup()

	resp, err := c.GetSubscriber(context.Background(), "missing-user")
	if !errors.Is(err, ErrSubscriberNotFound) {
		t.Fatalf("expected ErrSubscriberNotFound, got %v", err)
	}
	if resp == nil {
		t.Fatal("expected non-nil empty response on 404")
	}
	// PR-J2 made Subscriber a pointer so missing/empty payloads can be
	// distinguished from "subscriber present, no entitlements". 404 →
	// nil pointer is the documented soft-empty shape.
	if resp.Subscriber != nil && len(resp.Subscriber.Entitlements) != 0 {
		t.Fatalf("expected empty entitlements on 404, got %d", len(resp.Subscriber.Entitlements))
	}
}

// TestGetSubscriber401Permanent — 401 maps to ErrPermanent (sentinel
// wrapped via %w). The classification is what stops the webhook retry
// loop downstream.
func TestGetSubscriber401Permanent(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusUnauthorized, `{"message":"invalid api key"}`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("expected ErrPermanent for 401, got %v", err)
	}
}

// TestGetSubscriber403Permanent — 403 (often a scoped-wrong key) is the
// same class as 401: not going to fix itself, stop retrying.
func TestGetSubscriber403Permanent(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusForbidden, `{"message":"forbidden"}`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("expected ErrPermanent for 403, got %v", err)
	}
}

// TestGetSubscriber429RateLimited — 429 surfaces as a *RateLimitError
// carrying the Retry-After header. errors.Is on the sentinel must also
// succeed so callers that don't care about the value can use the simple
// form.
func TestGetSubscriber429RateLimited(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusTooManyRequests, `{}`, map[string]string{
		"Retry-After": strconv.Itoa(42),
	})
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("expected errors.Is(err, ErrRateLimited), got %v", err)
	}
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected errors.As to populate *RateLimitError, got %v", err)
	}
	if rl.RetryAfter != 42*time.Second {
		t.Fatalf("expected RetryAfter=42s, got %s", rl.RetryAfter)
	}
}

// TestGetSubscriber429NoRetryAfterHeader — when RC omits Retry-After,
// the typed error still surfaces but with RetryAfter=0. Callers know to
// fall back to their own backoff.
func TestGetSubscriber429NoRetryAfterHeader(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusTooManyRequests, `{}`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected *RateLimitError, got %v", err)
	}
	if rl.RetryAfter != 0 {
		t.Fatalf("expected RetryAfter=0 when header absent, got %s", rl.RetryAfter)
	}
}

// TestGetSubscriber500Retryable — 500 is neither ErrPermanent nor
// ErrRateLimited; callers treat it as transient (RC retries, reconcile
// will pick the user up on the next sweep).
func TestGetSubscriber500Retryable(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusInternalServerError, `internal`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if err == nil {
		t.Fatal("expected an error for 500")
	}
	if errors.Is(err, ErrPermanent) {
		t.Fatalf("500 must not classify as ErrPermanent, got %v", err)
	}
	if errors.Is(err, ErrRateLimited) {
		t.Fatalf("500 must not classify as ErrRateLimited, got %v", err)
	}
	if errors.Is(err, ErrSubscriberNotFound) {
		t.Fatalf("500 must not classify as ErrSubscriberNotFound, got %v", err)
	}
}

// TestGetSubscriber502Retryable — same idea as 500; explicit case
// because 502 / 504 are the realistic edge-of-network failures.
func TestGetSubscriber502Retryable(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusBadGateway, `bad gateway`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if err == nil {
		t.Fatal("expected an error for 502")
	}
	if errors.Is(err, ErrPermanent) {
		t.Fatalf("502 must not classify as ErrPermanent, got %v", err)
	}
}

// TestGetSubscriberOtherClientErrorPermanent — 400 (and other unhandled
// 4xx codes) classify as ErrPermanent so they hit the same "stop
// retrying" path as 401/403. We don't have a better story for them.
func TestGetSubscriberOtherClientErrorPermanent(t *testing.T) {
	c, cleanup := newTestClient(t, http.StatusBadRequest, `bad request`, nil)
	defer cleanup()

	_, err := c.GetSubscriber(context.Background(), "user-1")
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("expected ErrPermanent for 400, got %v", err)
	}
}

// TestParseRetryAfter — table-driven sanity check on Retry-After
// parsing. RC sends integer-seconds; we ignore HTTP-date form.
func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"", 0},
		{"30", 30 * time.Second},
		{"  60  ", 60 * time.Second},
		{"-1", 0},
		{"abc", 0},
		{"Mon, 01 Jan 2030 00:00:00 GMT", 0}, // HTTP-date form not supported
	}
	for _, tc := range cases {
		if got := parseRetryAfter(tc.in); got != tc.want {
			t.Errorf("parseRetryAfter(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
