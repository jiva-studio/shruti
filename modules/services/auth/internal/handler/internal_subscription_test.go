package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

// stubRemoteApplier is an in-memory SubscriptionApplier for the HMAC + dedup
// tests below. It records every call and lets the test prime the
// returned matched bool / error.
type stubRemoteApplier struct {
	mu       sync.Mutex
	calls    []store.SubscriptionSnapshot
	matched  map[string]bool // eventID → matched returned to caller
	errOnce  error
	defaultM bool
}

func (s *stubRemoteApplier) ApplyRemoteSubscription(_ context.Context, eventID string, snap store.SubscriptionSnapshot) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, snap)
	if s.errOnce != nil {
		e := s.errOnce
		s.errOnce = nil
		return false, e
	}
	if m, ok := s.matched[eventID]; ok {
		return m, nil
	}
	return s.defaultM, nil
}

// signBody computes the HMAC the same way the handler validates it.
func signBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestInternalSubscription_SecretUnset(t *testing.T) {
	h := &InternalSubscriptionHandler{Secret: "", Applier: &stubRemoteApplier{}}
	body := []byte(`{"event_id":"e1","app_user_id":"u1","tier":"pro"}`)
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status: want 503, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "not_configured") {
		t.Errorf("code: want not_configured, got %s", w.Body.String())
	}
}

func TestInternalSubscription_HMACValid(t *testing.T) {
	stub := &stubRemoteApplier{matched: map[string]bool{"ev-ok": true}}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	body, _ := json.Marshal(subscriptionApplyBody{
		EventID:      "ev-ok",
		AppUserID:    "u-1",
		Tier:         "pro",
		SourceRegion: "global",
	})
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	var out map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out["matched"] {
		t.Errorf("matched: want true, got %v", out)
	}
	if len(stub.calls) != 1 {
		t.Errorf("applier should run exactly once, got %d", len(stub.calls))
	}
	if stub.calls[0].AppUserID != "u-1" || stub.calls[0].Tier != "pro" {
		t.Errorf("snapshot mismatch: %+v", stub.calls[0])
	}
}

func TestInternalSubscription_HMACInvalid(t *testing.T) {
	stub := &stubRemoteApplier{}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	body := []byte(`{"event_id":"e","app_user_id":"u","tier":"free"}`)
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", "deadbeef") // not the right HMAC
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "bad_hmac") {
		t.Errorf("code: want bad_hmac, got %s", w.Body.String())
	}
	if len(stub.calls) != 0 {
		t.Errorf("applier must not run on HMAC failure, got %d calls", len(stub.calls))
	}
}

func TestInternalSubscription_HMACMissingHeader(t *testing.T) {
	stub := &stubRemoteApplier{}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	body := []byte(`{"event_id":"e","app_user_id":"u","tier":"free"}`)
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	// No X-Lectorium-HMAC header at all.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d", w.Code)
	}
}

func TestInternalSubscription_BadJSON(t *testing.T) {
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: &stubRemoteApplier{}}
	body := []byte(`{not-json`)
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestInternalSubscription_MissingFields(t *testing.T) {
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: &stubRemoteApplier{}}
	body, _ := json.Marshal(subscriptionApplyBody{Tier: "pro"}) // no event_id / app_user_id
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "bad_payload") {
		t.Errorf("code: want bad_payload, got %s", w.Body.String())
	}
}

func TestInternalSubscription_UnmatchedReturns200False(t *testing.T) {
	// Local DB doesn't own this app_user_id (user lives on another
	// region). The applier returns matched=false; the handler still
	// 200s so the broadcaster can continue to other regions.
	stub := &stubRemoteApplier{defaultM: false}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	body, _ := json.Marshal(subscriptionApplyBody{
		EventID:   "ev-miss",
		AppUserID: "u-not-here",
		Tier:      "pro",
	})
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	var out map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out["matched"] {
		t.Errorf("matched: want false, got %v", out)
	}
}

func TestInternalSubscription_TierExpiresAtMillisRoundTrip(t *testing.T) {
	// Wire shape: tier_expires_at is unix-millis. The handler converts
	// to *time.Time before handing to the applier — assert the
	// conversion happened (snapshot's pointer is non-nil and matches
	// the millis we sent).
	stub := &stubRemoteApplier{defaultM: true}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	expMillis := int64(1700000000000)
	body, _ := json.Marshal(subscriptionApplyBody{
		EventID:       "ev-expiry",
		AppUserID:     "u-x",
		Tier:          "pro",
		TierExpiresAt: &expMillis,
	})
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", w.Code)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("expected one apply call, got %d", len(stub.calls))
	}
	if stub.calls[0].TierExpiresAt == nil {
		t.Fatalf("TierExpiresAt nil; want non-nil from %d millis", expMillis)
	}
	if got := stub.calls[0].TierExpiresAt.UnixMilli(); got != expMillis {
		t.Errorf("TierExpiresAt round trip: want %d, got %d", expMillis, got)
	}
}

func TestInternalSubscription_LifetimeEntitlementStaysNil(t *testing.T) {
	// Lifetime entitlements arrive as `tier_expires_at: null` on the
	// wire → applier sees TierExpiresAt = nil.
	stub := &stubRemoteApplier{defaultM: true}
	h := &InternalSubscriptionHandler{Secret: "shared-secret", Applier: stub}

	body, _ := json.Marshal(subscriptionApplyBody{
		EventID:   "ev-life",
		AppUserID: "u-life",
		Tier:      "pro",
	})
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/apply", bytes.NewReader(body))
	r.Header.Set("X-Lectorium-HMAC", signBody("shared-secret", body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", w.Code)
	}
	if stub.calls[0].TierExpiresAt != nil {
		t.Errorf("TierExpiresAt: want nil for lifetime, got %v", stub.calls[0].TierExpiresAt)
	}
}

func TestValidateHMAC_ConstantTime(t *testing.T) {
	// Sanity check: identical bodies + secret produce equal HMACs;
	// any bit-flip in the secret or body invalidates the match.
	body := []byte(`{"x":1}`)
	want := signBody("k", body)
	if !validateHMAC(want, body, "k") {
		t.Error("matching HMAC must validate")
	}
	if validateHMAC(want, body, "k2") {
		t.Error("HMAC must reject wrong secret")
	}
	if validateHMAC(want, []byte(`{"x":2}`), "k") {
		t.Error("HMAC must reject mutated body")
	}
	if validateHMAC("", body, "k") {
		t.Error("HMAC must reject empty signature")
	}
}
