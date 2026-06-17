package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/metrics"
	"github.com/jiva-studio/shruti/auth/internal/rcclient"
	"github.com/jiva-studio/shruti/auth/internal/service"
	"github.com/jiva-studio/shruti/auth/internal/store"
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

// InsertOrLookup returns (inserted=true, processed=false) by default so
// the handler proceeds straight to the apply step — that's what the
// classification tests want to assert against. Use lookupErr to force
// the error path; lookupProcessed maps to processed=true (skipping apply
// via the duplicate short-circuit).
func (s *stubApplier) InsertOrLookup(_ context.Context, _, _ string) (inserted, processed bool, err error) {
	if s.lookupErr != nil {
		return false, false, s.lookupErr
	}
	if s.lookupProcessed {
		return false, true, nil
	}
	return true, false, s.insertErr
}

// WaitForSibling is a no-op stub — the unit tests don't exercise the
// concurrent-retry path. The integration test TestConcurrentWebhookRetry
// uses the real defaultApplier against Postgres.
func (s *stubApplier) WaitForSibling(_ context.Context, _ string) (bool, error) {
	return false, nil
}

func (s *stubApplier) Apply(_ context.Context, _ string, _ store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	s.mu.Lock()
	s.applyCalls++
	s.mu.Unlock()
	return s.applyUserID, s.applyMatched, s.applyErr
}

// recordingApplier is a richer stub than stubApplier: it records the
// event_ids passed to Apply and the app_user_id passed to InsertOrLookup,
// so the TRANSFER tests can assert the primary vs synthetic-source split
// and the store-and-defer path.
type recordingApplier struct {
	mu                  sync.Mutex
	applyCalls          int
	insertOrLookupCalls int
	lastInsertAppUserID string
	appliedEventIDs     []string
	applyUserID         uuid.UUID
	applyMatched        bool
}

func (s *recordingApplier) InsertOrLookup(_ context.Context, _, appUserID string) (inserted, processed bool, err error) {
	s.mu.Lock()
	s.insertOrLookupCalls++
	s.lastInsertAppUserID = appUserID
	s.mu.Unlock()
	return true, false, nil
}

func (s *recordingApplier) WaitForSibling(_ context.Context, _ string) (bool, error) {
	return false, nil
}

func (s *recordingApplier) Apply(_ context.Context, eventID string, _ store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	s.mu.Lock()
	s.applyCalls++
	s.appliedEventIDs = append(s.appliedEventIDs, eventID)
	s.mu.Unlock()
	return s.applyUserID, s.applyMatched, nil
}

func (s *recordingApplier) appliedEventID(want string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range s.appliedEventIDs {
		if id == want {
			return true
		}
	}
	return false
}

// recordingFetcher records every app_user_id GetSubscriber was asked for,
// returning the same canned response for all.
type recordingFetcher struct {
	mu      sync.Mutex
	resp    *rcclient.SubscriberResponse
	err     error
	fetched map[string]bool
}

func (s *recordingFetcher) GetSubscriber(_ context.Context, appUserID string) (*rcclient.SubscriberResponse, error) {
	s.mu.Lock()
	if s.fetched == nil {
		s.fetched = map[string]bool{}
	}
	s.fetched[appUserID] = true
	s.mu.Unlock()
	return s.resp, s.err
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

// stubFetcher returns a canned response/error from GetSubscriber and
// records the app_user_id it was asked to refetch.
type stubFetcher struct {
	resp          *rcclient.SubscriberResponse
	err           error
	lastAppUserID string
}

func (s *stubFetcher) GetSubscriber(_ context.Context, appUserID string) (*rcclient.SubscriberResponse, error) {
	s.lastAppUserID = appUserID
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

// TestRCWebhookPermanentErrorLeavesEventRetryable — when GetSubscriber
// returns ErrPermanent (e.g. a revoked API key), the handler must NOT
// seal the event: sealing freezes the user's current tier and a dropped
// revocation/refund would leave them on Pro forever. Instead it must:
//   - return 200 (so RC doesn't amplify the redelivery storm)
//   - call RecordError (leaving processed_at NULL → still retryable)
//   - NOT seal via MarkProcessedWithError
//   - NOT call Apply (no DB churn on a state we can't resolve)
//   - bump the auth-failed, permanent, and unresolved hard-alert counters
func TestRCWebhookPermanentErrorLeavesEventRetryable(t *testing.T) {
	const secret = "rc-secret"
	beforeCounter := metrics.RCAPIAuthFailedTotal.Value()
	beforePermanent := metrics.RCAPIPermanentTotal.Value()
	beforeUnresolved := metrics.RCWebhookPermanentUnresolvedTotal.Value()

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
		t.Fatalf("want 200 (avoid redelivery storm), got %d body=%s", w.Code, string(body))
	}
	if applier.applyCalls != 0 {
		t.Fatalf("apply must NOT run on permanent error, got %d calls", applier.applyCalls)
	}
	if events.markProcessedErrCalls != 0 {
		t.Fatalf("permanent failure must NOT seal the event, got %d MarkProcessedWithError calls",
			events.markProcessedErrCalls)
	}
	if events.recordErrCalls != 1 {
		t.Fatalf("expected RecordError called once (row stays retryable), got %d", events.recordErrCalls)
	}
	if !startsWith(events.recordErrLastMsg, "permanent: ") {
		t.Fatalf("expected message to start with 'permanent: ', got %q", events.recordErrLastMsg)
	}
	if got := metrics.RCAPIAuthFailedTotal.Value() - beforeCounter; got != 1 {
		t.Fatalf("expected rc_api_auth_failed_total +1, got +%d", got)
	}
	if got := metrics.RCAPIPermanentTotal.Value() - beforePermanent; got != 1 {
		t.Fatalf("expected rc_api_permanent_total +1, got +%d", got)
	}
	if got := metrics.RCWebhookPermanentUnresolvedTotal.Value() - beforeUnresolved; got != 1 {
		t.Fatalf("expected rc_webhook_permanent_unresolved_total +1, got +%d", got)
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

// TestRCWebhookTransferReconcilesDestination — a TRANSFER event carries
// no app_user_id; the entitlement now belongs to the id(s) in
// transferred_to. The handler must resolve the identified (non-anonymous)
// destination, refetch + apply THAT id, and return 200 — not 400.
func TestRCWebhookTransferReconcilesDestination(t *testing.T) {
	const secret = "rc-secret"
	applier := &stubApplier{applyUserID: uuid.New(), applyMatched: true}
	events := &stubEvents{}
	fetcher := &stubFetcher{resp: &rcclient.SubscriberResponse{}}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":               "evt_transfer_1",
			"type":             "TRANSFER",
			"environment":      "PRODUCTION",
			"transferred_from": []string{"$RCAnonymousID:anon123"},
			"transferred_to":   []string{"auth-uuid-dest"},
		},
	}))

	if w.Code != http.StatusOK {
		body, _ := io.ReadAll(w.Body)
		t.Fatalf("TRANSFER must reconcile destination → 200, got %d body=%s", w.Code, string(body))
	}
	if applier.applyCalls != 1 {
		t.Fatalf("expected Apply once for the transfer destination, got %d", applier.applyCalls)
	}
	if fetcher.lastAppUserID != "auth-uuid-dest" {
		t.Fatalf("expected refetch of identified destination, got %q", fetcher.lastAppUserID)
	}
}

// TestRCWebhookTransferOnlyAnonymousDestinationStored — when the only
// transfer destination is still anonymous ($RCAnonymousID:*), the id may
// bind to an auth.users row via Purchases.logIn moments later. 400-and-
// forget would lose the entitlement (nothing for the orphan sweep to
// replay), so the handler stores the event keyed on the anon id and
// returns 200 so the sweep can resolve it once the link materialises.
func TestRCWebhookTransferOnlyAnonymousDestinationStored(t *testing.T) {
	const secret = "rc-secret"
	applier := &recordingApplier{}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        &stubEvents{},
		Fetcher:       &stubFetcher{resp: &rcclient.SubscriberResponse{}},
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":             "evt_transfer_anon",
			"type":           "TRANSFER",
			"environment":    "PRODUCTION",
			"transferred_to": []string{"$RCAnonymousID:onlyAnon"},
		},
	}))

	if w.Code != http.StatusOK {
		body, _ := io.ReadAll(w.Body)
		t.Fatalf("want 200 store-and-defer for anon-only destination, got %d body=%s",
			w.Code, string(body))
	}
	if applier.applyCalls != 0 {
		t.Fatalf("apply must not run (no identified id to refetch), got %d", applier.applyCalls)
	}
	if applier.insertOrLookupCalls != 1 {
		t.Fatalf("event must be stored once for the orphan sweep, got %d InsertOrLookup calls",
			applier.insertOrLookupCalls)
	}
	if applier.lastInsertAppUserID != "$RCAnonymousID:onlyAnon" {
		t.Fatalf("event must be stored keyed on the anon target id, got %q",
			applier.lastInsertAppUserID)
	}
}

// TestRCWebhookTransferNoUsableIDs400 — a TRANSFER with no app_user_id
// and an empty transferred_to has nothing to refetch and nothing the
// sweep could ever resolve, so we keep the 400 to stop RC retrying.
func TestRCWebhookTransferNoUsableIDs400(t *testing.T) {
	const secret = "rc-secret"
	applier := &recordingApplier{}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        &stubEvents{},
		Fetcher:       &stubFetcher{resp: &rcclient.SubscriberResponse{}},
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":          "evt_transfer_empty",
			"type":        "TRANSFER",
			"environment": "PRODUCTION",
		},
	}))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 when no usable id at all, got %d", w.Code)
	}
	if applier.insertOrLookupCalls != 0 || applier.applyCalls != 0 {
		t.Fatalf("nothing must be stored or applied, got insert=%d apply=%d",
			applier.insertOrLookupCalls, applier.applyCalls)
	}
}

// TestRCWebhookTransferDowngradesIdentifiedSource — a TRANSFER moves the
// entitlement to transferred_to (refetched + applied as the primary id)
// AND, when transferred_from holds an identified id, that former owner
// must be downgraded inline (not left for the up-to-24h stale sweep, which
// would leave two Pro sessions from one purchase). The handler refetches
// BOTH ids and applies BOTH.
func TestRCWebhookTransferDowngradesIdentifiedSource(t *testing.T) {
	const secret = "rc-secret"
	applier := &recordingApplier{applyUserID: uuid.New(), applyMatched: true}
	events := &stubEvents{}
	fetcher := &recordingFetcher{resp: &rcclient.SubscriberResponse{}}
	h := &RCWebhookHandler{
		SecretPrimary: secret,
		Applier:       applier,
		Events:        events,
		Fetcher:       fetcher,
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mkRequest(t, secret, map[string]any{
		"event": map[string]any{
			"id":               "evt_transfer_src",
			"type":             "TRANSFER",
			"environment":      "PRODUCTION",
			"transferred_from": []string{"auth-uuid-src"},
			"transferred_to":   []string{"auth-uuid-dest"},
		},
	}))

	if w.Code != http.StatusOK {
		body, _ := io.ReadAll(w.Body)
		t.Fatalf("TRANSFER must reconcile both ends → 200, got %d body=%s", w.Code, string(body))
	}
	// Both the destination (primary apply) and the source (inline
	// downgrade) must have been refetched + applied.
	if applier.applyCalls != 2 {
		t.Fatalf("expected Apply twice (destination + source), got %d", applier.applyCalls)
	}
	if !fetcher.fetched["auth-uuid-dest"] {
		t.Fatalf("destination must be refetched, fetched=%v", fetcher.fetched)
	}
	if !fetcher.fetched["auth-uuid-src"] {
		t.Fatalf("identified source must be refetched for downgrade, fetched=%v", fetcher.fetched)
	}
	// The source apply must use a distinct synthetic event_id so it
	// doesn't collide with the primary event's idempotency row.
	if !applier.appliedEventID("evt_transfer_src") {
		t.Fatalf("primary apply must use the real event_id, got %v", applier.appliedEventIDs)
	}
	if !applier.appliedEventID("evt_transfer_src:from:auth-uuid-src") {
		t.Fatalf("source apply must use a distinct synthetic event_id, got %v", applier.appliedEventIDs)
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

// Webhook-side integration tests covering plan 1.2 (atomic idempotency
// against concurrent RC retries) and the unmatched/500 behaviour from
// plan 1.3.
//
// Mirrors the skip pattern in internal/service/service_test.go — needs
// TEST_DATABASE_URL set to a real Postgres. Off-CI runs skip cleanly.

const migrationsDir = "../../../../../infra/app/db/migrations"

func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run handler-layer integration tests")
	}
	return dsn
}

func resetSchema(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := store.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS auth CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS app CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.usage`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.schema_migrations`)

	authFiles, _ := filepath.Glob(filepath.Join(migrationsDir, "000[0-9]_auth_*.up.sql"))
	moreAuth, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_auth_*.up.sql"))
	authFiles = append(authFiles, moreAuth...)
	moreWebhook, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_rc_webhook_*.up.sql"))
	authFiles = append(authFiles, moreWebhook...)
	authFiles = append(authFiles,
		filepath.Join(migrationsDir, "0023_outbox.up.sql"),
		filepath.Join(migrationsDir, "0026_outbox_dedup.up.sql"),
	)
	sort.Strings(authFiles)
	for _, p := range authFiles {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read migration %s: %v", p, err)
		}
		if _, err := pool.Exec(context.Background(), string(b)); err != nil {
			t.Fatalf("apply migration %s: %v", p, err)
		}
	}
	return pool
}

func tempKeys(t *testing.T) (privPath, pubPath string) {
	t.Helper()
	dir := t.TempDir()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	privPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	pubBytes, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	pubPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubBytes,
	})
	privPath = filepath.Join(dir, "private.pem")
	pubPath = filepath.Join(dir, "public.pem")
	_ = os.WriteFile(privPath, privPEM, 0o600)
	_ = os.WriteFile(pubPath, pubPEM, 0o644)
	return
}

// rcStub is a tiny HTTP server replacing RC's REST API. It returns a
// fixed entitlement set keyed on whatever app_user_id the handler asks
// for and counts hits so tests can assert against fan-out.
type rcStub struct {
	srv         *httptest.Server
	hits        atomic.Int64
	expiresDate time.Time
}

func newRCStub(t *testing.T) *rcStub {
	t.Helper()
	s := &rcStub{expiresDate: time.Now().UTC().Add(30 * 24 * time.Hour)}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		body := map[string]any{
			"subscriber": map[string]any{
				"entitlements": map[string]any{
					"pro": map[string]any{
						"expires_date":       s.expiresDate.Format(time.RFC3339),
						"product_identifier": "shruti.pro.monthly",
					},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func bootWebhook(t *testing.T) (*RCWebhookHandler, *service.Service, *rcStub) {
	t.Helper()
	dsn := dbDSNFromEnv(t)
	pool := resetSchema(t, dsn)
	t.Cleanup(pool.Close)

	priv, pub := tempKeys(t)
	signer, _ := jwt.NewSignerFromFile(priv)
	verifier, _ := jwt.NewVerifierFromFile(pub)

	svc := &service.Service{
		Pool:          pool,
		Users:         &store.UserRepo{Pool: pool},
		Identities:    &store.IdentityRepo{Pool: pool},
		RefreshTokens: &store.RefreshTokenRepo{Pool: pool},
		WebhookEvents: &store.WebhookEventRepo{Pool: pool},
		Signer:        signer,
		Verifier:      verifier,
	}

	stub := newRCStub(t)
	rc := &rcclient.Client{
		BaseURL: stub.srv.URL,
		APIKey:  "stub-key",
		HTTP:    stub.srv.Client(),
	}
	h := &RCWebhookHandler{
		SecretPrimary: "stub-secret",
		Svc:           svc,
		RC:            rc,
	}
	return h, svc, stub
}

func postWebhook(h *RCWebhookHandler, eventID, appUserID string) *httptest.ResponseRecorder {
	payload := map[string]any{
		"event": map[string]any{
			"id":          eventID,
			"type":        "INITIAL_PURCHASE",
			"app_user_id": appUserID,
			"environment": "PRODUCTION",
		},
	}
	b, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/revenuecat", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer stub-secret")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// TestConcurrentWebhookRetry — plan 1.2.
//
// Ten goroutines POST the same event_id at the same time. With the
// new InsertOrLookup + advisory-lock idempotency, exactly ONE outbox
// row must materialise. Sibling retries either short-circuit on the
// processed_at=NOT NULL path or wait on the advisory lock and then
// observe the completed result.
func TestConcurrentWebhookRetry(t *testing.T) {
	h, svc, _ := bootWebhook(t)
	ctx := context.Background()

	// Seed a user with a bound rc_app_user_id so matched=true.
	const appUserID = "rc-app-user-concurrent"
	var userID string
	if err := svc.Pool.QueryRow(ctx,
		`INSERT INTO auth.users(rc_app_user_id) VALUES ($1) RETURNING id`,
		appUserID,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	const n = 10
	const eventID = "ev-concurrent-1"
	var wg sync.WaitGroup
	statuses := make(chan int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := postWebhook(h, eventID, appUserID)
			statuses <- rr.Code
		}()
	}
	wg.Wait()
	close(statuses)

	var ok, other int
	for code := range statuses {
		switch code {
		case http.StatusOK:
			ok++
		default:
			other++
		}
	}
	if other != 0 {
		t.Errorf("expected all 10 concurrent calls to 200, got %d non-200", other)
	}
	if ok != n {
		t.Errorf("expected %d ok responses, got %d", n, ok)
	}

	// Exactly one outbox row, regardless of how the retries interleaved.
	var outboxN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND aggregate_id=$1`,
		userID,
	).Scan(&outboxN); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxN != 1 {
		t.Errorf("expected exactly 1 outbox row across %d retries, got %d", n, outboxN)
	}

	// processed_at set, error cleared.
	var processedAt *time.Time
	var errStr *string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT processed_at, error FROM auth.rc_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt, &errStr); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if processedAt == nil {
		t.Error("processed_at must be set after concurrent retries settle")
	}
	if errStr != nil {
		t.Errorf("error must be NULL after success, got %q", *errStr)
	}
}

// TestWebhookReturns500WhenUnmatched — plan 1.3 / 1.2 wiring.
//
// The webhook lands before Purchases.logIn → no auth.users row owns
// rc_app_user_id → handler must return 500 (so RC retries within its
// 80-min budget) and leave processed_at NULL on the row.
func TestWebhookReturns500WhenUnmatched(t *testing.T) {
	h, svc, _ := bootWebhook(t)
	ctx := context.Background()

	const eventID = "ev-unbound-1"
	const appUserID = "rc-app-user-unbound"

	rr := postWebhook(h, eventID, appUserID)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on unmatched, got %d (body=%s)", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "unmatched") {
		t.Errorf("expected error code 'unmatched' in body, got %s", rr.Body.String())
	}

	var processedAt *time.Time
	var errStr *string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT processed_at, error FROM auth.rc_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt, &errStr); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if processedAt != nil {
		t.Errorf("processed_at must stay NULL on unmatched, got %v", *processedAt)
	}
	if errStr == nil || *errStr != "no rc_app_user_id match" {
		t.Errorf("expected error='no rc_app_user_id match', got %v", errStr)
	}
}

// TestDuplicateEventShortCircuits — plan 1.2.
//
// Once an event_id has reached processed_at != NULL, subsequent POSTs
// return 200 with duplicate=true and DO NOT re-emit outbox.
func TestDuplicateEventShortCircuits(t *testing.T) {
	h, svc, stub := bootWebhook(t)
	ctx := context.Background()

	const appUserID = "rc-app-user-dup"
	var userID string
	if err := svc.Pool.QueryRow(ctx,
		`INSERT INTO auth.users(rc_app_user_id) VALUES ($1) RETURNING id`,
		appUserID,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	const eventID = "ev-dup-1"
	rr1 := postWebhook(h, eventID, appUserID)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first call expected 200, got %d", rr1.Code)
	}
	hitsAfterFirst := stub.hits.Load()
	if hitsAfterFirst != 1 {
		t.Errorf("first call should refetch from RC once, got %d hits", hitsAfterFirst)
	}

	rr2 := postWebhook(h, eventID, appUserID)
	if rr2.Code != http.StatusOK {
		t.Fatalf("second call expected 200, got %d", rr2.Code)
	}
	if !strings.Contains(rr2.Body.String(), "duplicate") {
		t.Errorf("second call body must signal duplicate, got %s", rr2.Body.String())
	}
	if stub.hits.Load() != hitsAfterFirst {
		t.Errorf("duplicate event must NOT re-hit RC API: hits went %d → %d",
			hitsAfterFirst, stub.hits.Load())
	}

	var outboxN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND aggregate_id=$1`,
		userID,
	).Scan(&outboxN); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxN != 1 {
		t.Errorf("expected 1 outbox row after duplicate, got %d", outboxN)
	}
}
