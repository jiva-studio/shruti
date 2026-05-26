package service

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/akdasa-studios/lectorium/auth/internal/rcclient"
	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

func TestSnapshotFromRCResponse(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	future := now.Add(30 * 24 * time.Hour)
	past := now.Add(-1 * time.Hour)

	tests := []struct {
		name        string
		resp        *rcclient.SubscriberResponse
		wantTier    string
		wantExpires *time.Time
	}{
		{
			name:     "nil response",
			resp:     nil,
			wantTier: TierFree,
		},
		{
			name:     "empty response (no subscriber)",
			resp:     &rcclient.SubscriberResponse{},
			wantTier: TierFree,
		},
		{
			name: "no entitlements",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
				},
			},
			wantTier: TierFree,
		},
		{
			name: "expired entitlement is free",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: &past},
					},
				},
			},
			wantTier: TierFree,
		},
		{
			name: "active entitlement is pro",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: &future},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: &future,
		},
		{
			name: "lifetime entitlement is pro with nil expires",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: nil},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: nil,
		},
		{
			name: "lifetime beats any dated entitlement",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro":      {ExpiresDate: &future},
						"lifetime": {ExpiresDate: nil},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SnapshotFromRCResponse("app_user_1", tc.resp, now)
			if got.Tier != tc.wantTier {
				t.Errorf("tier: got %q, want %q", got.Tier, tc.wantTier)
			}
			if (got.TierExpiresAt == nil) != (tc.wantExpires == nil) {
				t.Errorf("expires nil-ness: got %v, want %v", got.TierExpiresAt, tc.wantExpires)
			}
			if got.TierExpiresAt != nil && tc.wantExpires != nil && !got.TierExpiresAt.Equal(*tc.wantExpires) {
				t.Errorf("expires: got %v, want %v", *got.TierExpiresAt, *tc.wantExpires)
			}
			if got.AppUserID != "app_user_1" {
				t.Errorf("AppUserID lost: got %q", got.AppUserID)
			}
		})
	}
}

// ─── Integration: webhook idempotency / unmatched / advisory lock ───
//
// Each test boots its own DB via the shared helper in service_test.go.
// Tests skip cleanly when TEST_DATABASE_URL is unset (see dbDSNFromEnv).

// bootSubscription wires a Service with the same fixture as the regular
// boot() but also attaches a WebhookEventRepo so the subscription path
// can write rc_webhook_events rows. Returns the Service plus a helper
// to bind rc_app_user_id on an auth.users row (Purchases.logIn analogue).
func bootSubscription(t *testing.T) *Service {
	t.Helper()
	svc, _ := boot(t)
	svc.WebhookEvents = &store.WebhookEventRepo{Pool: svc.Pool}
	return svc
}

func seedWebhookEvent(t *testing.T, svc *Service, eventID, appUserID string) {
	t.Helper()
	_, err := svc.Pool.Exec(context.Background(),
		`INSERT INTO auth.rc_webhook_events(event_id, app_user_id) VALUES ($1, $2)`,
		eventID, appUserID,
	)
	if err != nil {
		t.Fatalf("seed webhook event: %v", err)
	}
}

func bindRCAppUserID(t *testing.T, svc *Service, userID, appUserID string) {
	t.Helper()
	_, err := svc.Pool.Exec(context.Background(),
		`UPDATE auth.users SET rc_app_user_id = $2 WHERE id = $1`,
		userID, appUserID,
	)
	if err != nil {
		t.Fatalf("bind rc_app_user_id: %v", err)
	}
}

func proSnapshot(appUserID string) store.SubscriptionSnapshot {
	t := time.Now().UTC().Add(30 * 24 * time.Hour)
	return store.SubscriptionSnapshot{AppUserID: appUserID, Tier: TierPro, TierExpiresAt: &t}
}

// TestUnmatchedWebhookKeepsUnprocessed — plan 1.3.
//
// Webhook for an rc_app_user_id that no auth.users row owns must leave
// processed_at=NULL so RC keeps retrying within its 80-min budget.
// error column carries the cause for the orphan sweep.
func TestUnmatchedWebhookKeepsUnprocessed(t *testing.T) {
	svc := bootSubscription(t)
	ctx := context.Background()

	const eventID = "ev-unmatched-1"
	const appUserID = "rc-app-user-orphan"
	seedWebhookEvent(t, svc, eventID, appUserID)

	_, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID))
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if matched {
		t.Fatal("expected matched=false (no auth.users row bound)")
	}

	var processedAt *time.Time
	var errStr *string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT processed_at, error FROM auth.rc_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt, &errStr); err != nil {
		t.Fatalf("scan row: %v", err)
	}
	if processedAt != nil {
		t.Errorf("processed_at must stay NULL, got %v", *processedAt)
	}
	if errStr == nil || *errStr != "no rc_app_user_id match" {
		t.Errorf("expected error='no rc_app_user_id match', got %v", errStr)
	}

	// No outbox row either — the unmatched path must not leak events.
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox WHERE event_type = 'subscription.changed'`,
	).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 subscription.changed outbox rows, got %d", n)
	}
}

// TestMatchedWebhookMarksProcessed — sibling to TestUnmatched.
//
// Once the rc_app_user_id is bound, the same apply call must succeed:
// processed_at set, error cleared, outbox row written.
func TestMatchedWebhookMarksProcessed(t *testing.T) {
	svc := bootSubscription(t)
	ctx := context.Background()

	const eventID = "ev-matched-1"
	const appUserID = "rc-app-user-matched"
	first, err := svc.Anonymous(ctx, "dev-match", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	bindRCAppUserID(t, svc, first.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, eventID, appUserID)

	uid, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID))
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !matched || uid != first.UserID {
		t.Fatalf("expected matched=true userID=%s, got matched=%v uid=%s", first.UserID, matched, uid)
	}

	var processedAt *time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if processedAt == nil {
		t.Error("processed_at must be set on matched apply")
	}

	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND aggregate_id=$1`,
		first.UserID.String(),
	).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if n != 1 {
		t.Errorf("expected exactly 1 outbox row, got %d", n)
	}
}

// (Plan 1.2 — TestConcurrentWebhookRetry — exercises the handler-side
// InsertOrLookup + advisory-lock idempotency end-to-end via httptest;
// see internal/handler/rc_webhook_test.go.)

// TestConcurrentApplySerialised — plan 1.4.
//
// Two ApplyRCSubscriberState calls against the same rc_app_user_id
// from independent goroutines must serialise on the advisory lock —
// the second one sees the result of the first. The end-state is
// deterministic (last writer wins) and there's exactly ONE outbox
// row per distinct event_id.
func TestConcurrentApplySerialised(t *testing.T) {
	svc := bootSubscription(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-serialise", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-serialise"
	bindRCAppUserID(t, svc, first.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, "ev-ser-1", appUserID)
	seedWebhookEvent(t, svc, "ev-ser-2", appUserID)

	now := time.Now().UTC()
	expiresA := now.Add(30 * 24 * time.Hour)
	expiresB := now.Add(60 * 24 * time.Hour)

	snapA := store.SubscriptionSnapshot{AppUserID: appUserID, Tier: TierPro, TierExpiresAt: &expiresA}
	snapB := store.SubscriptionSnapshot{AppUserID: appUserID, Tier: TierPro, TierExpiresAt: &expiresB}

	var (
		wg            sync.WaitGroup
		errA, errB    error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _, errA = svc.ApplyRCSubscriberState(ctx, "ev-ser-1", snapA)
	}()
	go func() {
		defer wg.Done()
		_, _, errB = svc.ApplyRCSubscriberState(ctx, "ev-ser-2", snapB)
	}()
	wg.Wait()

	if errA != nil {
		t.Fatalf("apply A: %v", errA)
	}
	if errB != nil {
		t.Fatalf("apply B: %v", errB)
	}

	// Two distinct event_ids → two outbox rows (the lock serialises
	// but doesn't dedup distinct events; idempotency keys on event_id).
	var outboxN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND aggregate_id=$1`,
		first.UserID.String(),
	).Scan(&outboxN); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxN != 2 {
		t.Errorf("expected 2 outbox rows (one per event_id), got %d", outboxN)
	}

	// tier_expires_at is whichever applied last — deterministic by
	// commit order under the lock. Both candidates are valid; what
	// matters is that no torn write happened.
	u, err := svc.Users.Get(ctx, first.UserID)
	if err != nil {
		t.Fatalf("user get: %v", err)
	}
	if u == nil || u.Tier != TierPro {
		t.Fatalf("expected user tier=pro, got %v", u)
	}
	if u.TierExpiresAt == nil {
		t.Errorf("tier_expires_at must be set, got nil")
	} else {
		// PG round-trips at microsecond resolution and tags the value
		// with the server's TZ (usually UTC); equality must compare on
		// instant, not on Time fields.
		gotUnix := u.TierExpiresAt.UnixMicro()
		if gotUnix != expiresA.UnixMicro() && gotUnix != expiresB.UnixMicro() {
			t.Errorf("tier_expires_at must equal one of the snapshots, got %v (unix %d) vs A=%d B=%d",
				u.TierExpiresAt, gotUnix, expiresA.UnixMicro(), expiresB.UnixMicro())
		}
	}

	// Both webhook rows marked processed.
	var pendingN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.rc_webhook_events
		  WHERE processed_at IS NULL AND event_id IN ('ev-ser-1','ev-ser-2')`,
	).Scan(&pendingN); err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if pendingN != 0 {
		t.Errorf("expected both events processed, %d still pending", pendingN)
	}
}

// ─── PR-2b: cross-region broadcast outbox row ──────────────────────────
//
// On the global region, every matched RC webhook write must also
// produce a sibling `subscription.broadcast` outbox row sharing the
// same source_event_id (so duplicate RC retries collapse onto one
// broadcast). Non-global regions don't broadcast — RC's dashboard is
// configured to send to global only.

// TestBroadcastWrittenWhenRegionIsGlobal — the global region produces
// both 'subscription.changed' AND 'subscription.broadcast' from a
// single matched RC webhook, both sharing the RC event_id as
// source_event_id.
func TestBroadcastWrittenWhenRegionIsGlobal(t *testing.T) {
	svc := bootSubscription(t)
	svc.RegionID = "global"
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-broadcast-global", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-bcast-g"
	const eventID = "ev-bcast-global-1"
	bindRCAppUserID(t, svc, first.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, eventID, appUserID)

	if _, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID)); err != nil {
		t.Fatalf("apply: %v", err)
	} else if !matched {
		t.Fatal("expected matched=true")
	}

	// Exactly one 'subscription.changed' row.
	var changedN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND source_event_id=$1`,
		eventID,
	).Scan(&changedN); err != nil {
		t.Fatalf("count changed: %v", err)
	}
	if changedN != 1 {
		t.Errorf("expected 1 subscription.changed row, got %d", changedN)
	}

	// Exactly one 'subscription.broadcast' row, same source_event_id.
	var bcastN int
	var bcastPayload []byte
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*), max(payload::text)::bytea FROM app.outbox
		  WHERE event_type='subscription.broadcast' AND source_event_id=$1`,
		eventID,
	).Scan(&bcastN, &bcastPayload); err != nil {
		t.Fatalf("count broadcast: %v", err)
	}
	if bcastN != 1 {
		t.Errorf("expected 1 subscription.broadcast row, got %d", bcastN)
	}

	// Payload shape: must carry event_id + app_user_id + tier +
	// source_region. tier_expires_at is the RC entitlement expiry in
	// unix-ms (or absent/null for lifetime).
	var p struct {
		EventID       string `json:"event_id"`
		AppUserID     string `json:"app_user_id"`
		Tier          string `json:"tier"`
		TierExpiresAt *int64 `json:"tier_expires_at"`
		SourceRegion  string `json:"source_region"`
	}
	if err := json.Unmarshal(bcastPayload, &p); err != nil {
		t.Fatalf("payload unmarshal: %v (raw=%s)", err, string(bcastPayload))
	}
	if p.EventID != eventID {
		t.Errorf("payload event_id=%q, want %q", p.EventID, eventID)
	}
	if p.AppUserID != appUserID {
		t.Errorf("payload app_user_id=%q, want %q", p.AppUserID, appUserID)
	}
	if p.Tier != TierPro {
		t.Errorf("payload tier=%q, want %q", p.Tier, TierPro)
	}
	if p.SourceRegion != "global" {
		t.Errorf("payload source_region=%q, want %q", p.SourceRegion, "global")
	}
	if p.TierExpiresAt == nil || *p.TierExpiresAt == 0 {
		t.Errorf("payload tier_expires_at must be non-nil ms for a Pro snapshot, got %v", p.TierExpiresAt)
	}
}

// TestBroadcastSuppressedWhenRegionIsNonGlobal — Russia (or any non-
// global) region must NOT emit a broadcast row even on a matched
// webhook. RC won't send webhooks there in production, but the guard
// protects against accidental dashboard misconfiguration.
func TestBroadcastSuppressedWhenRegionIsNonGlobal(t *testing.T) {
	svc := bootSubscription(t)
	svc.RegionID = "russia"
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-broadcast-ru", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-bcast-ru"
	const eventID = "ev-bcast-ru-1"
	bindRCAppUserID(t, svc, first.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, eventID, appUserID)

	if _, matched, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID)); err != nil {
		t.Fatalf("apply: %v", err)
	} else if !matched {
		t.Fatal("expected matched=true")
	}

	var changedN, bcastN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.changed' AND source_event_id=$1`,
		eventID,
	).Scan(&changedN); err != nil {
		t.Fatalf("count changed: %v", err)
	}
	if changedN != 1 {
		t.Errorf("expected 1 subscription.changed row, got %d", changedN)
	}

	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.broadcast' AND source_event_id=$1`,
		eventID,
	).Scan(&bcastN); err != nil {
		t.Fatalf("count broadcast: %v", err)
	}
	if bcastN != 0 {
		t.Errorf("expected 0 subscription.broadcast rows on non-global, got %d", bcastN)
	}
}

// TestBroadcastDedupOnDuplicateEventID — two RC retries of the same
// event_id may both reach the apply path (intra-tx processed_at
// re-check is the canonical short-circuit, but the
// (event_type, source_event_id) partial unique index from migration
// 0026 is the defence-in-depth). Confirm at most one broadcast row.
func TestBroadcastDedupOnDuplicateEventID(t *testing.T) {
	svc := bootSubscription(t)
	svc.RegionID = "global"
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-bcast-dedup", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-bcast-dedup"
	const eventID = "ev-bcast-dedup-1"
	bindRCAppUserID(t, svc, first.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, eventID, appUserID)

	// First apply: writes both rows.
	if _, _, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID)); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	// Second apply on the same eventID: the intra-tx processed_at re-
	// check inside ApplyRCSubscriberState returns early. The partial
	// unique index would catch a regression that tried to INSERT
	// twice.
	if _, _, err := svc.ApplyRCSubscriberState(ctx, eventID, proSnapshot(appUserID)); err != nil {
		t.Fatalf("second apply: %v", err)
	}

	var bcastN int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox
		  WHERE event_type='subscription.broadcast' AND source_event_id=$1`,
		eventID,
	).Scan(&bcastN); err != nil {
		t.Fatalf("count broadcast: %v", err)
	}
	if bcastN != 1 {
		t.Errorf("expected exactly 1 broadcast row across duplicate applies, got %d", bcastN)
	}
}
