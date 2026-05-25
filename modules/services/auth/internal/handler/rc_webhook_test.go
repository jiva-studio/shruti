package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"errors"
	"net/http/httptest"
	"sync"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/akdasa-studios/shruti/auth/internal/metrics"
	"github.com/akdasa-studios/shruti/auth/internal/rcclient"
	"github.com/akdasa-studios/shruti/auth/internal/store"
)

// TestBearerCheck covers the matrix:
//   - valid primary secret  → accepted
//   - valid secondary secret → accepted (during a rotation)
//   - mismatching token     → rejected
//   - missing Authorization → rejected
//   - empty slots           → rejected even on empty Bearer (defence
//     against an unset rotation slot matching a header like "Bearer ").
func TestBearerCheck(t *testing.T) {
	h := &RCWebhookHandler{
		SecretPrimary:   "primary-secret-value",
		SecretSecondary: "secondary-secret-value",
	}

	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"primary accepted", "Bearer primary-secret-value", true},
		{"secondary accepted", "Bearer secondary-secret-value", true},
		{"wrong secret rejected", "Bearer not-the-secret", false},
		{"missing header rejected", "", false},
		{"non-bearer scheme rejected", "Basic primary-secret-value", false},
		{"empty bearer value rejected", "Bearer ", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			if got := h.checkBearer(r); got != tc.want {
				t.Fatalf("checkBearer(%q) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}

// TestBearerCheckSecondaryOnly verifies that primary can be unset during
// the final phase of rotation (operator cleared the old key and only the
// new secondary is live).
func TestBearerCheckSecondaryOnly(t *testing.T) {
	h := &RCWebhookHandler{SecretSecondary: "new-only"}
	r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
	r.Header.Set("Authorization", "Bearer new-only")
	if !h.checkBearer(r) {
		t.Fatal("secondary-only setup must accept its own secret")
	}
}

// TestBearerCheckBothEmpty — defensive: if the operator boots with both
// slots empty (misconfiguration) we must never accept any request.
// main.go also guards this at boot, this is belt-and-suspenders for the
// handler in isolation.
func TestBearerCheckBothEmpty(t *testing.T) {
	h := &RCWebhookHandler{}
	r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
	r.Header.Set("Authorization", "Bearer anything")
	if h.checkBearer(r) {
		t.Fatal("empty secrets must reject every request")
	}
	// And specifically reject "Bearer " (empty token) so an unset slot
	// can't be coerced by an empty-token attack.
	r.Header.Set("Authorization", "Bearer ")
	if h.checkBearer(r) {
		t.Fatal("empty secrets must reject an empty-token bearer too")
	}
}

// stubApplier records the calls the handler makes against the
// idempotency + apply surface. Used to assert that the permanent-error
// path does NOT proceed to Apply.
type stubApplier struct {
	mu              sync.Mutex
	lookupProcessed bool
	lookupErr       error
	insertErr       error
	applyCalls      int
	applyUserID     uuid.UUID
	applyMatched    bool
	applyErr        error
}

func (s *stubApplier) LookupProcessed(_ context.Context, _ string) (bool, error) {
	return s.lookupProcessed, s.lookupErr
}
func (s *stubApplier) InsertEvent(_ context.Context, _ string) error { return s.insertErr }
func (s *stubApplier) Apply(_ context.Context, _ string, _ store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	s.mu.Lock()
	s.applyCalls++
	s.mu.Unlock()
	return s.applyUserID, s.applyMatched, s.applyErr
}

// stubEvents records the calls the handler makes against the webhook-
// events store. We care about which "seal" path got hit.
type stubEvents struct {
	mu                      sync.Mutex
	recordErrCalls          int
	recordErrLastMsg        string
	markProcessedErrCalls   int
	markProcessedErrLastMsg string
}

func (s *stubEvents) RecordError(_ context.Context, _ string, msg string) error {
	s.mu.Lock()
	s.recordErrCalls++
	s.recordErrLastMsg = msg
	s.mu.Unlock()
	return nil
}

func (s *stubEvents) MarkProcessedWithError(_ context.Context, _ string, msg string) error {
	s.mu.Lock()
	s.markProcessedErrCalls++
	s.markProcessedErrLastMsg = msg
	s.mu.Unlock()
	return nil
}

// stubFetcher returns a canned response/error from GetSubscriber.
type stubFetcher struct {
	resp *rcclient.SubscriberResponse
	err  error
}

func (s *stubFetcher) GetSubscriber(_ context.Context, _ string) (*rcclient.SubscriberResponse, error) {
	return s.resp, s.err
}

// mkRequest builds a POST /webhooks/revenuecat request with the given
// event payload and the secret pre-set on the handler.
func mkRequest(t *testing.T, secret string, payload map[string]any) *http.Request {
	t.Helper()
	buf := &bytes.Buffer{}
	if err := json.NewEncoder(buf).Encode(payload); err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/webhooks/revenuecat", buf)
	r.Header.Set("Authorization", "Bearer "+secret)
	r.Header.Set("Content-Type", "application/json")
	return r
}

// TestRCWebhookPermanentError200AndMarkProcessed — when GetSubscriber
// returns ErrPermanent (e.g. 401), the handler must:
//   - return 200 (so RC stops retrying)
//   - call MarkProcessedWithError with a "permanent: …" prefix
//   - NOT call Apply (no DB churn)
//   - bump the auth-failed counter
func TestRCWebhookPermanentError200AndMarkProcessed(t *testing.T) {
	const secret = "rc-secret"
	beforeCounter := metrics.RCAPIAuthFailedTotal.Value()
	beforePermanent := metrics.RCAPIPermanentTotal.Value()

	applier := &stubApplier{}
	events := &stubEvents{}
	fetcher := &stubFetcher{
		err: fmt.Errorf("%w: status=401 body={\"message\":\"invalid api key\"}", rcclient.ErrPermanent),
	}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":          "evt_test_permanent_1",
			"type":        "INITIAL_PURCHASE",
			"app_user_id": "rc_user_1",
			"environment": "PRODUCTION",
		},
	}))

	if w.Code != http.StatusOK {
		body, _ := io.ReadAll(w.Body)
		t.Fatalf("want 200 (so RC stops retrying), got %d body=%s", w.Code, string(body))
	}
	if applier.applyCalls != 0 {
		t.Fatalf("apply must NOT run on permanent error, got %d calls", applier.applyCalls)
	}
	if events.markProcessedErrCalls != 1 {
		t.Fatalf("expected MarkProcessedWithError called once, got %d", events.markProcessedErrCalls)
	}
	if !startsWith(events.markProcessedErrLastMsg, "permanent: ") {
		t.Fatalf("expected message to start with 'permanent: ', got %q", events.markProcessedErrLastMsg)
	}
	if got := metrics.RCAPIAuthFailedTotal.Value() - beforeCounter; got != 1 {
		t.Fatalf("expected rc_api_auth_failed_total +1, got +%d", got)
	}
	if got := metrics.RCAPIPermanentTotal.Value() - beforePermanent; got != 1 {
		t.Fatalf("expected rc_api_permanent_total +1, got +%d", got)
	}
}

// TestRCWebhookRateLimited500AndRecordError — 429 is transient; the
// handler must return 500 (so RC retries) and call RecordError (not
// MarkProcessedWithError), and bump the rate-limited counter.
func TestRCWebhookRateLimited500AndRecordError(t *testing.T) {
	const secret = "rc-secret"
	beforeCounter := metrics.RCAPIRateLimitedTotal.Value()

	applier := &stubApplier{}
	events := &stubEvents{}
	fetcher := &stubFetcher{err: &rcclient.RateLimitError{Status: 429}}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":          "evt_test_429",
			"type":        "INITIAL_PURCHASE",
			"app_user_id": "rc_user_2",
			"environment": "PRODUCTION",
		},
	}))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 (RC retries), got %d", w.Code)
	}
	if events.recordErrCalls != 1 {
		t.Fatalf("expected RecordError called once, got %d", events.recordErrCalls)
	}
	if events.markProcessedErrCalls != 0 {
		t.Fatalf("MarkProcessedWithError must NOT fire on 429, got %d calls",
			events.markProcessedErrCalls)
	}
	if got := metrics.RCAPIRateLimitedTotal.Value() - beforeCounter; got != 1 {
		t.Fatalf("expected rc_api_rate_limited_total +1, got +%d", got)
	}
}

// TestRCWebhookSubscriberNotFoundProceeds — 404 is a soft success: the
// handler must NOT mark the event errored, NOT skip Apply, and return
// 200. The Apply call should see an empty snapshot (tier=free).
func TestRCWebhookSubscriberNotFoundProceeds(t *testing.T) {
	const secret = "rc-secret"
	applier := &stubApplier{
		applyUserID:  uuid.New(),
		applyMatched: true,
	}
	events := &stubEvents{}
	fetcher := &stubFetcher{
		resp: &rcclient.SubscriberResponse{},
		err:  rcclient.ErrSubscriberNotFound,
	}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":          "evt_test_404",
			"type":        "INITIAL_PURCHASE",
			"app_user_id": "rc_user_3",
			"environment": "PRODUCTION",
		},
	}))

	if w.Code != http.StatusOK {
		t.Fatalf("want 200 for 404 soft-success, got %d", w.Code)
	}
	if applier.applyCalls != 1 {
		t.Fatalf("apply must run on 404 with empty snapshot, got %d calls", applier.applyCalls)
	}
	if events.markProcessedErrCalls != 0 {
		t.Fatalf("MarkProcessedWithError must NOT fire on 404, got %d", events.markProcessedErrCalls)
	}
	if events.recordErrCalls != 0 {
		t.Fatalf("RecordError must NOT fire on 404, got %d", events.recordErrCalls)
	}
}

// TestRCWebhookGenericServerError500 — 5xx from RC is plain-error
// (no sentinel match); same 500 + RecordError path as 429 minus the
// rate-limit counter bump.
func TestRCWebhookGenericServerError500(t *testing.T) {
	const secret = "rc-secret"
	applier := &stubApplier{}
	events := &stubEvents{}
	fetcher := &stubFetcher{err: fmt.Errorf("rcclient: 502 Bad Gateway")}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":          "evt_test_5xx",
			"type":        "INITIAL_PURCHASE",
			"app_user_id": "rc_user_4",
			"environment": "PRODUCTION",
		},
	}))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", w.Code)
	}
	if events.recordErrCalls != 1 {
		t.Fatalf("expected RecordError called once, got %d", events.recordErrCalls)
	}
	if events.markProcessedErrCalls != 0 {
		t.Fatalf("MarkProcessedWithError must NOT fire on 5xx, got %d", events.markProcessedErrCalls)
	}
	if applier.applyCalls != 0 {
		t.Fatalf("apply must NOT run on 5xx, got %d", applier.applyCalls)
	}
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func TestSanitizeRCError(t *testing.T) {
	tests := []struct {
		name string
		in   error
		want string
	}{
		{
			name: "nil",
			in:   nil,
			want: "",
		},
		{
			name: "plain rcclient wrap",
			in:   errors.New("rcclient: 502 Bad Gateway"),
			want: "rcclient: 502 Bad Gateway",
		},
		{
			name: "redacts email",
			in:   errors.New("rcclient: 401: invalid user user.name+x@example.co.uk in body"),
			want: "rcclient: 401: invalid user <email> in body",
		},
		{
			name: "redacts phone with plus",
			in:   errors.New("rcclient: 400: bad params +14155552671 rejected"),
			want: "rcclient: 400: bad params <phone> rejected",
		},
		{
			name: "redacts bare digit run",
			in:   errors.New("rcclient: 400: subscriber id 1234567890 not valid"),
			want: "rcclient: 400: subscriber id <phone> not valid",
		},
		{
			name: "preserves short numbers (status codes etc.)",
			in:   errors.New("rcclient: 502 Bad Gateway"),
			want: "rcclient: 502 Bad Gateway",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeRCError(tc.in)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeRCErrorTruncatesTo200(t *testing.T) {
	long := strings.Repeat("abc ", 100) // 400 chars
	err := errors.New(long)
	got := sanitizeRCError(err)
	if len(got) > 200 {
		t.Errorf("len: got %d, want <= 200", len(got))
	}
}

func TestSanitizeRCErrorRedactsBothEmailAndPhone(t *testing.T) {
	err := errors.New("rcclient: 400: alice@example.com / +15555555555 invalid")
	got := sanitizeRCError(err)
	if strings.Contains(got, "@example.com") {
		t.Errorf("email leaked: %q", got)
	}
	if strings.Contains(got, "+1555") {
		t.Errorf("phone leaked: %q", got)
	}
}
