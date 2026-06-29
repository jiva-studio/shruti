package rcclient_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/auth/internal/rcclient"
	"github.com/jiva-studio/lectorium/auth/internal/service"
)

// These tests cross the rcclient → service boundary on purpose: the
// JSON shape and the snapshot derivation are a single contract and
// regress together, so we test them together.

const (
	bodyEmptyEntitlements = `{
		"subscriber": {
			"original_app_user_id": "app_user_1",
			"entitlements": {}
		}
	}`

	bodyMultipleEntitlements = `{
		"subscriber": {
			"original_app_user_id": "app_user_1",
			"entitlements": {
				"pro_monthly": {
					"expires_date": "2026-06-25T12:00:00Z",
					"product_identifier": "pro.monthly"
				},
				"pro_annual": {
					"expires_date": "2026-12-25T12:00:00Z",
					"product_identifier": "pro.annual"
				},
				"old_quarterly": {
					"expires_date": "2026-04-25T12:00:00Z",
					"product_identifier": "pro.quarterly"
				}
			}
		}
	}`

	bodyLifetime = `{
		"subscriber": {
			"original_app_user_id": "app_user_1",
			"entitlements": {
				"lifetime": {
					"expires_date": null,
					"product_identifier": "pro.lifetime"
				}
			}
		}
	}`

	bodyTrial = `{
		"subscriber": {
			"original_app_user_id": "app_user_1",
			"entitlements": {
				"pro_trial": {
					"expires_date": "2026-06-01T12:00:00Z",
					"product_identifier": "pro.monthly",
					"period_type": "trial"
				}
			}
		}
	}`

	// "Malformed" here = no `subscriber` key at all (the field the
	// schema marks as required). Returns a present but empty/zero
	// SubscriberResponse with a nil Subscriber pointer.
	bodyMalformedNoSubscriber = `{
		"request_date_ms": 1716638400000
	}`

	// Malformed-2: subscriber present but missing original_app_user_id.
	bodyMalformedNoOriginalID = `{
		"subscriber": {
			"entitlements": {
				"pro": {
					"expires_date": "2026-12-25T12:00:00Z"
				}
			}
		}
	}`
)

func newTestServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func decodeBody(t *testing.T, body string) *rcclient.SubscriberResponse {
	t.Helper()
	var out rcclient.SubscriberResponse
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return &out
}

func TestSnapshotFromRCEmptyEntitlements(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	resp := decodeBody(t, bodyEmptyEntitlements)

	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierFree {
		t.Fatalf("tier: got %q, want %q", snap.Tier, service.TierFree)
	}
	if snap.TierExpiresAt != nil {
		t.Errorf("expires: got %v, want nil", snap.TierExpiresAt)
	}
}

func TestSnapshotFromRCMultipleEntitlements(t *testing.T) {
	// `now` between the expired quarterly and the active monthly.
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	resp := decodeBody(t, bodyMultipleEntitlements)

	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierPro {
		t.Fatalf("tier: got %q, want %q", snap.Tier, service.TierPro)
	}
	// Latest active = annual (Dec 2026), beats the monthly (Jun 2026).
	want := time.Date(2026, 12, 25, 12, 0, 0, 0, time.UTC)
	if snap.TierExpiresAt == nil || !snap.TierExpiresAt.Equal(want) {
		t.Errorf("expires: got %v, want %v", snap.TierExpiresAt, want)
	}
}

func TestSnapshotFromRCLifetime(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	resp := decodeBody(t, bodyLifetime)

	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierPro {
		t.Fatalf("tier: got %q, want %q", snap.Tier, service.TierPro)
	}
	if snap.TierExpiresAt != nil {
		t.Errorf("lifetime should have nil expires; got %v", snap.TierExpiresAt)
	}
}

func TestSnapshotFromRCTrial(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	resp := decodeBody(t, bodyTrial)

	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierPro {
		t.Fatalf("tier: got %q, want %q", snap.Tier, service.TierPro)
	}
	want := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	if snap.TierExpiresAt == nil || !snap.TierExpiresAt.Equal(want) {
		t.Errorf("expires: got %v, want %v", snap.TierExpiresAt, want)
	}
}

func TestSnapshotFromRCMalformedNoSubscriber(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	before := service.RCResponseMalformedTotal()
	resp := decodeBody(t, bodyMalformedNoSubscriber)

	// Must not panic.
	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierFree {
		t.Errorf("malformed → tier should be free; got %q", snap.Tier)
	}
	if got := service.RCResponseMalformedTotal(); got != before+1 {
		t.Errorf("malformed counter: got delta %d, want 1", got-before)
	}
}

func TestSnapshotFromRCMalformedNoOriginalID(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	before := service.RCResponseMalformedTotal()
	resp := decodeBody(t, bodyMalformedNoOriginalID)

	// Must not panic; entitlements still derive cleanly even though
	// the required field is missing.
	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierPro {
		t.Errorf("entitlements still valid → tier should be pro; got %q", snap.Tier)
	}
	if got := service.RCResponseMalformedTotal(); got != before+1 {
		t.Errorf("malformed counter: got delta %d, want 1", got-before)
	}
}

func TestSnapshotFromRCZeroExpiresDateIsLifetime(t *testing.T) {
	// RC has been observed emitting "0001-01-01T00:00:00Z" on certain
	// synthetic test payloads. The consumer treats that as unset, not
	// as "expired in year 1".
	const body = `{
		"subscriber": {
			"original_app_user_id": "app_user_1",
			"entitlements": {
				"pro": {
					"expires_date": "0001-01-01T00:00:00Z"
				}
			}
		}
	}`
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	resp := decodeBody(t, body)

	snap := service.SnapshotFromRCResponse("app_user_1", resp, now)
	if snap.Tier != service.TierPro {
		t.Fatalf("zero ExpiresDate → tier should be pro; got %q", snap.Tier)
	}
	if snap.TierExpiresAt != nil {
		t.Errorf("zero ExpiresDate → expires should be nil; got %v", snap.TierExpiresAt)
	}
}

func TestGetSubscriber404IsEmpty(t *testing.T) {
	// PR-F (merged) made 404 return `ErrSubscriberNotFound` as a sentinel —
	// the caller treats it as a soft success at the handler/cron level
	// (apply with an empty snapshot, no retry). Here we just assert the
	// classification and the empty-resp shape.
	srv := newTestServer(t, `{"message":"not found"}`, http.StatusNotFound)
	defer srv.Close()

	c := &rcclient.Client{BaseURL: srv.URL, APIKey: "k", HTTP: srv.Client()}
	resp, err := c.GetSubscriber(context.Background(), "missing")
	if !errors.Is(err, rcclient.ErrSubscriberNotFound) {
		t.Fatalf("404 should map to ErrSubscriberNotFound; got %v", err)
	}
	if resp == nil {
		t.Fatal("404: got nil resp, want empty resp")
	}
	if resp.Subscriber != nil {
		t.Errorf("404: Subscriber should be nil, got %+v", resp.Subscriber)
	}
}

func TestGetSubscriberDecodesRealisticBody(t *testing.T) {
	srv := newTestServer(t, bodyMultipleEntitlements, http.StatusOK)
	defer srv.Close()

	c := &rcclient.Client{BaseURL: srv.URL, APIKey: "k", HTTP: srv.Client()}
	resp, err := c.GetSubscriber(context.Background(), "app_user_1")
	if err != nil {
		t.Fatalf("GetSubscriber: %v", err)
	}
	if resp.Subscriber == nil {
		t.Fatal("Subscriber: nil")
	}
	if resp.Subscriber.OriginalAppUserID != "app_user_1" {
		t.Errorf("OriginalAppUserID: got %q, want app_user_1", resp.Subscriber.OriginalAppUserID)
	}
	if got := len(resp.Subscriber.Entitlements); got != 3 {
		t.Errorf("entitlement count: got %d, want 3", got)
	}
}
