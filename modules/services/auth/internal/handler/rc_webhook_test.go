package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/infra/postgres"
	"github.com/jiva-studio/shruti/auth/internal/infra/revenuecat"
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

// stubDeliveries answers every delivery with one outcome and keeps what it
// was handed.
type stubDeliveries struct {
	outcome rcsync.Outcome
	got     []rcsync.Delivery
}

func (s *stubDeliveries) HandleDelivery(_ context.Context, d rcsync.Delivery) rcsync.Outcome {
	s.got = append(s.got, d)
	return s.outcome
}

// Every outcome of the use case has one answer to RevenueCat: 200 stops its
// retries, 400 drops the event, 500 asks it to redeliver.
func TestRCWebhookMapsOutcome(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome rcsync.Outcome
		status  int
		body    string
	}{
		{"processed", rcsync.Processed, http.StatusOK, `{"ok":true}`},
		{"duplicate", rcsync.Duplicate, http.StatusOK, `{"duplicate":true,"ok":true}`},
		{"deferred", rcsync.Deferred, http.StatusOK, `{"deferred":true,"ok":true}`},
		{"unresolvable", rcsync.Unresolvable, http.StatusOK, `{"ok":false,"permanent":true}`},
		{"no app_user_id", rcsync.NoAppUserID, http.StatusBadRequest,
			`{"error":{"code":"bad_request","message":"missing app_user_id"}}`},
		{"rc unavailable", rcsync.RCUnavailable, http.StatusInternalServerError,
			`{"error":{"code":"rc_unavailable","message":"refetch failed"}}`},
		{"unmatched", rcsync.Unmatched, http.StatusInternalServerError,
			`{"error":{"code":"unmatched","message":"rc_app_user_id not bound yet"}}`},
		{"defer failed", rcsync.DeferFailed, http.StatusInternalServerError,
			`{"error":{"code":"db_error","message":"store anon transfer failed"}}`},
		{"record failed", rcsync.RecordFailed, http.StatusInternalServerError,
			`{"error":{"code":"db_error","message":"idempotency probe failed"}}`},
		{"apply failed", rcsync.ApplyFailed, http.StatusInternalServerError,
			`{"error":{"code":"db_error","message":"apply failed"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &RCWebhookHandler{SecretPrimary: "s", Deliveries: &stubDeliveries{outcome: tc.outcome}}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, mkRequest(t, "s", map[string]any{
				"event": map[string]any{"id": "evt_map", "app_user_id": "u", "environment": "PRODUCTION"},
			}))
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if got := strings.TrimSpace(w.Body.String()); got != tc.body {
				t.Fatalf("body = %s, want %s", got, tc.body)
			}
		})
	}
}

func TestRCWebhookPassesDelivery(t *testing.T) {
	deliveries := &stubDeliveries{outcome: rcsync.Processed}
	h := &RCWebhookHandler{SecretPrimary: "s", Deliveries: deliveries}

	h.ServeHTTP(httptest.NewRecorder(), mkRequest(t, "s", map[string]any{
		"event": map[string]any{
			"id":               "evt_transfer",
			"type":             "TRANSFER",
			"app_user_id":      "",
			"environment":      "PRODUCTION",
			"transferred_from": []string{"auth-uuid-src"},
			"transferred_to":   []string{"$RCAnonymousID:a", "auth-uuid-dest"},
		},
	}))

	want := []rcsync.Delivery{{
		EventID:         "evt_transfer",
		Type:            "TRANSFER",
		TransferredFrom: []string{"auth-uuid-src"},
		TransferredTo:   []string{"$RCAnonymousID:a", "auth-uuid-dest"},
	}}
	if !reflect.DeepEqual(deliveries.got, want) {
		t.Fatalf("delivered %+v, want %+v", deliveries.got, want)
	}
}

// Requests the transport answers itself never reach the use case.
func TestRCWebhookAnswersBeforeTheUseCase(t *testing.T) {
	for _, tc := range []struct {
		name   string
		isProd bool
		req    func(t *testing.T) *http.Request
		status int
		body   string
	}{
		{"wrong secret", false, func(t *testing.T) *http.Request {
			return mkRequest(t, "wrong", map[string]any{"event": map[string]any{"id": "e", "app_user_id": "u"}})
		}, http.StatusUnauthorized, `{"error":{"code":"unauthorized","message":"bad webhook secret"}}`},
		{"malformed body", false, func(t *testing.T) *http.Request {
			r := httptest.NewRequest(http.MethodPost, "/webhooks/revenuecat", strings.NewReader("{"))
			r.Header.Set("Authorization", "Bearer s")
			return r
		}, http.StatusOK, `{"ok":false}`},
		{"no event id", false, func(t *testing.T) *http.Request {
			return mkRequest(t, "s", map[string]any{"event": map[string]any{"app_user_id": "u"}})
		}, http.StatusOK, `{"ok":false}`},
		{"sandbox in prod", true, func(t *testing.T) *http.Request {
			return mkRequest(t, "s", map[string]any{"event": map[string]any{"id": "e", "app_user_id": "u", "environment": "SANDBOX"}})
		}, http.StatusOK, `{"ok":true,"skipped":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deliveries := &stubDeliveries{outcome: rcsync.Processed}
			h := &RCWebhookHandler{SecretPrimary: "s", IsProd: tc.isProd, Deliveries: deliveries}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, tc.req(t))
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if got := strings.TrimSpace(w.Body.String()); got != tc.body {
				t.Fatalf("body = %s, want %s", got, tc.body)
			}
			if len(deliveries.got) != 0 {
				t.Fatalf("use case reached with %+v", deliveries.got)
			}
		})
	}
}

// Webhook-side integration tests covering atomic idempotency against
// concurrent RC retries and the unmatched/500 behaviour.
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
	pool, err := postgres.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	_, _ = pool.Exec(t.Context(), `DROP SCHEMA IF EXISTS auth CASCADE`)
	_, _ = pool.Exec(t.Context(), `DROP SCHEMA IF EXISTS app CASCADE`)
	_, _ = pool.Exec(t.Context(), `DROP TABLE IF EXISTS public.usage`)
	_, _ = pool.Exec(t.Context(), `DROP TABLE IF EXISTS public.schema_migrations`)

	authFiles, _ := filepath.Glob(filepath.Join(migrationsDir, "000[0-9]_auth_*.up.sql"))
	moreAuth, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_auth_*.up.sql"))
	authFiles = append(authFiles, moreAuth...)
	moreWebhook, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_rc_webhook_*.up.sql"))
	authFiles = append(authFiles, moreWebhook...)
	moreAuth3040, _ := filepath.Glob(filepath.Join(migrationsDir, "00[3-9][0-9]_auth_*.up.sql"))
	authFiles = append(authFiles, moreAuth3040...)
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
		if _, err := pool.Exec(t.Context(), string(b)); err != nil {
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

func bootWebhook(t *testing.T) (*RCWebhookHandler, *testApp, *rcStub) {
	t.Helper()
	dsn := dbDSNFromEnv(t)
	pool := resetSchema(t, dsn)
	t.Cleanup(pool.Close)

	svc := newTestApp(t, appOptions{pool: pool})

	stub := newRCStub(t)
	svc.Sync.RC = &revenuecat.Client{
		BaseURL: stub.srv.URL,
		APIKey:  "stub-key",
		HTTP:    stub.srv.Client(),
	}
	h := &RCWebhookHandler{
		SecretPrimary: "stub-secret",
		Deliveries:    svc.Sync,
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

// TestConcurrentWebhookRetry: ten goroutines POST the same event_id at
// the same time. Exactly one outbox row must materialise: sibling retries
// either short-circuit on processed_at in InsertOrLookup, or reach Apply,
// which re-reads processed_at under the per-customer lock.
func TestConcurrentWebhookRetry(t *testing.T) {
	h, svc, _ := bootWebhook(t)
	ctx := t.Context()

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

// TestWebhookReturns500WhenUnmatched: the webhook lands before
// Purchases.logIn → no auth.users row owns
// rc_app_user_id → handler must return 500 (so RC retries within its
// 80-min budget) and leave processed_at NULL on the row.
func TestWebhookReturns500WhenUnmatched(t *testing.T) {
	h, svc, _ := bootWebhook(t)
	ctx := t.Context()

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

// TestDuplicateEventShortCircuits: once an event_id has reached
// processed_at != NULL, subsequent POSTs return 200 with duplicate=true
// and do not re-emit outbox.
func TestDuplicateEventShortCircuits(t *testing.T) {
	h, svc, stub := bootWebhook(t)
	ctx := t.Context()

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
