package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/rcclient"
)

// TestInterleavedWebhooksKeepNewestSnapshot: webhook A fetches the RC
// subscriber first (pro) but its apply is delayed; webhook B fetches later
// (refund → free) and applies first. A's older snapshot must not overwrite
// B's newer one, and A's event is still sealed processed so RC stops
// redelivering it.
func TestInterleavedWebhooksKeepNewestSnapshot(t *testing.T) {
	h, svc, _ := bootWebhook(t)
	ctx := t.Context()

	const appUserID = "rc-app-user-interleave"
	var userID string
	if err := svc.Pool.QueryRow(ctx,
		`INSERT INTO auth.users(rc_app_user_id) VALUES ($1) RETURNING id`, appUserID,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	proUntil := time.Now().UTC().Add(30 * 24 * time.Hour)
	fetchedA := make(chan struct{})
	releaseA := make(chan struct{})
	var calls atomic.Int64
	base := time.Now().UnixMilli()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := calls.Add(1)
		requestDate := base + n*1000 // RC's clock: B is answered after A
		entitlements := map[string]any{}
		if n == 1 {
			entitlements["pro"] = map[string]any{"expires_date": proUntil.Format(time.RFC3339)}
		}
		body := map[string]any{
			"request_date_ms": requestDate,
			"subscriber": map[string]any{
				"original_app_user_id": appUserID,
				"entitlements":         entitlements,
			},
		}
		if n == 1 {
			close(fetchedA)
			<-releaseA
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(body); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	h.RC = &rcclient.Client{BaseURL: srv.URL, APIKey: "stub-key", HTTP: srv.Client()}

	var wg sync.WaitGroup
	var codeA int
	wg.Add(1)
	go func() {
		defer wg.Done()
		codeA = postWebhook(h, "ev-interleave-A", appUserID).Code
	}()
	<-fetchedA
	if code := postWebhook(h, "ev-interleave-B", appUserID).Code; code != http.StatusOK {
		t.Fatalf("webhook B: got %d, want 200", code)
	}
	close(releaseA)
	wg.Wait()
	if codeA != http.StatusOK {
		t.Fatalf("webhook A: got %d, want 200", codeA)
	}

	var tier string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT tier FROM auth.users WHERE id = $1`, userID,
	).Scan(&tier); err != nil {
		t.Fatalf("read tier: %v", err)
	}
	if tier != "free" {
		t.Fatalf("tier = %q after the older pro snapshot applied last, want free", tier)
	}
	var pending int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.rc_webhook_events
		  WHERE processed_at IS NULL AND event_id IN ('ev-interleave-A','ev-interleave-B')`,
	).Scan(&pending); err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if pending != 0 {
		t.Fatalf("%d events left unprocessed; a stale snapshot is still sealed processed", pending)
	}
}
