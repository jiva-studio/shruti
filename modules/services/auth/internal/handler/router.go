// Package handler wires HTTP routes for the auth service.
package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/akdasa-studios/shruti/auth/internal/jwt"
	"github.com/akdasa-studios/shruti/auth/internal/service"
)

// deleteAccountWindow is the cooldown between two /auth/account/delete
// attempts from the same user. Set per the threat model: a normal user
// triggers delete once; anything more is either a confused tap or a
// stolen-token loop. 24h is enough to be safe even if the cleanup-worker
// is mid-purge from the first hit.
const deleteAccountWindow = 24 * time.Hour

// NewRouter wires every /auth/* endpoint.
//
// If svc is nil the router still serves /auth/healthz (boot probe before deps
// are wired). The RC webhook route is wired separately by AttachRCWebhook
// — main.go enables it only when the secret + REST API key are configured.
func NewRouter(svc *service.Service, verifier *jwt.Verifier) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/auth/healthz", healthz)
	// /metrics is on the same chi mux so observability scrapers don't need
	// a second port. Currently exposes the default Go process collectors
	// plus rc_webhook_auth_total (see rc_webhook.go); other services in the
	// stack still scrape postgres-exporter for DB-derived metrics.
	r.Handle("/metrics", promhttp.Handler())

	if svc == nil {
		return r
	}

	h := &authHandler{svc: svc, verifier: verifier}
	deleteLimiter := newUserRateLimiter(deleteAccountWindow)

	r.Post("/auth/anonymous", h.anonymous)
	r.Post("/auth/signin/google", h.signinGoogle)
	r.Post("/auth/signin/apple", h.signinApple)
	r.Post("/auth/refresh", h.refresh)
	// /whoami is the public country-hint endpoint used by mobile's
	// Welcome auto-detect (PR-3). Not under /auth/* because no auth
	// claim is being asserted — it's a pure read of the request IP
	// resolved by Caddy. Currently returns {"country":""}; see
	// whoami.go for the GeoIP TODO.
	r.Get("/whoami", h.whoami)
	// /auth/lookup is the no-side-effects existence probe used by
	// mobile's retry-other-region flow. No bearer required — the
	// (provider, subject) pair is the credential. Rate-limited at
	// Caddy edge alongside /auth/signin/*.
	r.Post("/auth/lookup", h.lookup)
	// Cross-region migration (Wave 4 / PR-2a). The bearer is the only
	// credential — verified through the multi-kid Verifier; trust is
	// implied by the kid being in JWT_PUBLIC_KEYS_DIR. No bearer
	// middleware here because the bearer may have been signed by ANY
	// trusted region (requireBearer pins to verifier.Verify which is
	// fine, but migration handlers want the resolved kid back too,
	// hence the inline VerifyAnyKid call).
	r.Post("/auth/migrate-in", h.migrateIn)
	r.Post("/auth/migrate-revoke", h.migrateRevoke)

	r.Group(func(r chi.Router) {
		r.Use(requireBearer(verifier))
		r.Post("/auth/signout", h.signout)
		r.Get("/auth/me", h.me)

		// Per-user throttle scoped to the delete endpoint only —
		// signout/me are normal-frequency calls and must not pick up
		// the 24h cooldown. The limiter records on entry, so an attempt
		// that ultimately returns 204, 410 or 5xx all count: a stolen
		// token can't spam the cleanup-worker by triggering errors.
		r.With(rateLimitPerUser(deleteLimiter)).
			Post("/auth/account/delete", h.deleteAccount)
	})
	return r
}

// AttachRCWebhook adds the RevenueCat webhook endpoint to an existing
// router. Called from main.go after the secret + REST client are
// resolved, so the route is only live when properly configured.
//
// The endpoint is intentionally outside /auth/* — it carries its own
// Bearer auth (the secret from the RC dashboard), not a user JWT.
func AttachRCWebhook(r http.Handler, h *RCWebhookHandler) http.Handler {
	chiR, ok := r.(chi.Router)
	if !ok {
		return r
	}
	chiR.Post("/webhooks/revenuecat", h.ServeHTTP)
	return chiR
}

// attachInternalSubscription wires POST /internal/subscription/apply
// onto an existing chi router. Mounted regardless of whether the
// HMAC secret is configured — the handler itself returns 503 on
// missing secret so operators get a clear "not enabled yet" signal
// instead of a 404 that looks like a routing bug.
func attachInternalSubscription(r http.Handler, h *InternalSubscriptionHandler) http.Handler {
	chiR, ok := r.(chi.Router)
	if !ok {
		return r
	}
	chiR.Post("/internal/subscription/apply", h.ServeHTTP)
	return chiR
}

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs
// → ENVs). Empty in local-dev binaries; operators hit /healthz post-
// deploy to confirm Watchtower rolled the new image.
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"build": map[string]string{
			"sha":  buildSHA,
			"time": buildTime,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
