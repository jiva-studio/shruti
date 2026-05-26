package handler

// Wave 4 / PR-2a — POST /internal/subscription/apply.
//
// Receives RC subscriber-state snapshots forwarded from another region
// via the cross-region outbox broadcast (PR-2b builds the sender from
// the cleanup-worker side). HMAC-validated against LECTORIUM_INTERNAL_
// SECRET — the operator shares the same secret across every region's
// auth container; the cleanup-worker uses it to sign every fan-out
// delivery.
//
// Idempotency: the snapshot's `event_id` (the RC original) is the
// dedup key, shared with the local RC webhook path's
// auth.rc_webhook_events table. So a snapshot can arrive
//   - in-region via /webhooks/revenuecat (local RC delivery), AND
//   - from another region via /internal/subscription/apply (broadcast),
// and only the first one to land wins; the second short-circuits on
// the unique (event_id) constraint.
//
// Opt-in: an empty InternalSecret disables the endpoint (503
// not_configured) — same pattern as the RC webhook when no secret is
// wired. Operators who haven't enabled cross-region delivery yet (the
// only-Cloud Provider deployment, today) leave it empty and get a clear
// "not configured" reply for any test traffic.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

// InternalSubscriptionHandler is wired by main.go only when both
// dependencies are present: the Service for the apply path, and a
// non-empty Secret. Tests can construct it directly with a stub
// applier via the SubscriptionApplier seam.
//
// SubscriptionApplier abstracts service.Service.ApplyRemoteSubscription
// so tests can inject a fake without touching the DB.
type SubscriptionApplier interface {
	ApplyRemoteSubscription(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (bool, error)
}

type InternalSubscriptionHandler struct {
	// Secret is the HMAC key. Empty → ServeHTTP returns 503.
	Secret string
	// Applier is the production *service.Service in prod and a fake in
	// tests. Nil → 500 internal (defence in depth, main.go won't wire
	// the handler without a service).
	Applier SubscriptionApplier
}

// subscriptionApplyBody is the wire shape of the broadcast payload.
// Keep field tags stable — the sender (cleanup-worker in PR-2b) will
// match this layout exactly.
type subscriptionApplyBody struct {
	EventID       string `json:"event_id"`        // RC original event id (idempotency key)
	AppUserID     string `json:"app_user_id"`     // RC app_user_id; the destination matches against auth.users.rc_app_user_id
	Tier          string `json:"tier"`            // "free" | "pro" (echoed into auth.users.tier)
	TierExpiresAt *int64 `json:"tier_expires_at"` // unix-MILLIS (nullable; lifetime entitlements omit it)
	SourceRegion  string `json:"source_region"`   // audit-only; logged but not stored
}

// ServeHTTP runs the HMAC check, decodes the body, and forwards to
// service.ApplyRemoteSubscription. The response shape is:
//
//	{"matched": <bool>}
//
// where matched=true means a local auth.users row owns the app_user_id
// (state was actually updated) and matched=false means we didn't have
// the user — the broadcaster keeps trying other regions until one
// claims it.
//
// 503 not_configured — Secret empty (operator hasn't enabled cross-region delivery)
// 400 read / bad_json — body fails to read / decode
// 401 bad_hmac        — HMAC mismatch
// 500 internal        — apply step failed
// 200 + {matched: bool} — normal success or duplicate event_id (matched
//                          reflects the prior delivery's outcome)
func (h *InternalSubscriptionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Secret == "" {
		writeErr(w, http.StatusServiceUnavailable, "not_configured", "internal secret unset")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read", err.Error())
		return
	}
	if !validateHMAC(r.Header.Get("X-Lectorium-HMAC"), body, h.Secret) {
		writeErr(w, http.StatusUnauthorized, "bad_hmac", "")
		return
	}
	var p subscriptionApplyBody
	if err := json.Unmarshal(body, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if p.EventID == "" || p.AppUserID == "" {
		writeErr(w, http.StatusBadRequest, "bad_payload", "event_id and app_user_id required")
		return
	}
	if h.Applier == nil {
		slog.ErrorContext(r.Context(), "subscription_apply_no_applier")
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	matched, err := h.Applier.ApplyRemoteSubscription(r.Context(), p.EventID, store.SubscriptionSnapshot{
		AppUserID:     p.AppUserID,
		Tier:          p.Tier,
		TierExpiresAt: unixMsToTimePtr(p.TierExpiresAt),
	})
	if err != nil {
		slog.ErrorContext(r.Context(), "subscription_apply_failed",
			"event_id", p.EventID,
			"source_region", p.SourceRegion,
			"err", err.Error())
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	slog.InfoContext(r.Context(), "subscription_apply",
		"event_id", p.EventID,
		"source_region", p.SourceRegion,
		"matched", matched,
		"tier", p.Tier)
	writeJSON(w, http.StatusOK, map[string]bool{"matched": matched})
}

// validateHMAC compares the received hex-encoded SHA-256 HMAC against
// the freshly computed one in constant time. Empty `received` falls
// through to a constant-time compare against the empty string so the
// branch shape stays identical (no early "no header" return).
func validateHMAC(received string, body []byte, secret string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(received), []byte(want))
}

// unixMsToTimePtr coerces the JSON `tier_expires_at` (UNIX millis,
// nullable) into the *time.Time the SubscriptionSnapshot carries.
// nil / 0 → nil so the lifetime-entitlement convention survives the
// wire trip ("Pro forever" stays NULL in auth.users.tier_expires_at).
func unixMsToTimePtr(ms *int64) *time.Time {
	if ms == nil || *ms == 0 {
		return nil
	}
	t := time.UnixMilli(*ms).UTC()
	return &t
}

// AttachInternalSubscription registers POST /internal/subscription/apply
// on the existing chi router. Called from main.go after config is
// loaded; when InternalSecret is empty the handler still mounts but
// every call returns 503 (cheaper than fork-on-config branches in
// router construction).
func AttachInternalSubscription(r http.Handler, h *InternalSubscriptionHandler) http.Handler {
	return attachInternalSubscription(r, h)
}
