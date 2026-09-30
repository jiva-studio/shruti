// Package handler wires HTTP routes for the auth service.
package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/jiva-studio/shruti/auth/internal/application/account"
	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/wire"
	"github.com/jiva-studio/shruti/authjwt"
)

// deleteAccountWindow is the cooldown between two /auth/account/delete
// attempts from the same user. Set per the threat model: a normal user
// triggers delete once; anything more is either a confused tap or a
// stolen-token loop. 24h is enough to be safe even if the cleanup-worker
// is mid-purge from the first hit.
const deleteAccountWindow = 24 * time.Hour

// otpRequestPerIP / otpRequestIPWindow bound how many email-OTP codes a
// single IP can request. Generous enough for a user fat-fingering their
// email a few times, tight enough that one source can't fan out a spam
// blast across many addresses. The per-email resend cooldown (DB) is the
// durable second layer.
const (
	// Each anonymous identity carries its own daily chat, title and
	// questions quota, so minting is what an abuser scales.
	anonMintPerIP    = 20
	anonMintIPWindow = 10 * time.Minute

	otpRequestPerIP    = 10
	otpRequestIPWindow = 10 * time.Minute
	// Verify is additionally bounded per-code by the atomic attempt cap; this
	// per-IP limit stops one source from hammering guesses across many codes
	// or addresses.
	otpVerifyPerIP    = 30
	otpVerifyIPWindow = 10 * time.Minute
)

// Deps is what the /auth/* routes call. Verifier authenticates the bearer
// routes.
type Deps struct {
	Sessions *session.Service
	SignIn   *signin.Service
	EmailOTP *emailotp.Service
	Accounts *account.Service
	Verifier *authjwt.Verifier
}

// NewRouter wires every /auth/* endpoint.
//
// If d is nil the router still serves /auth/healthz (boot probe before deps
// are wired). The RC webhook route is wired separately by AttachRCWebhook
// — main.go enables it only when the secret + REST API key are configured.
func NewRouter(d *Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/auth/healthz", healthz)
	// /metrics is on the same chi mux so observability scrapers don't need
	// a second port. It serves the default registry: the Go process
	// collectors, the webhook counters in rc_webhook.go and the RevenueCat
	// counters in internal/metrics. DB-derived metrics come from
	// postgres-exporter.
	r.Handle("/metrics", promhttp.Handler())

	if d == nil {
		return r
	}

	h := &authHandler{sessions: d.Sessions, signIn: d.SignIn, accounts: d.Accounts}
	otp := &emailOTPHandler{codes: d.EmailOTP}
	deleteLimiter := newUserRateLimiter(deleteAccountWindow)

	anonLimiter := newCountingLimiter(anonMintPerIP, anonMintIPWindow)
	otpRequestLimiter := newCountingLimiter(otpRequestPerIP, otpRequestIPWindow)
	otpVerifyLimiter := newCountingLimiter(otpVerifyPerIP, otpVerifyIPWindow)

	r.With(rateLimitPerIP(anonLimiter)).Post("/auth/anonymous", h.anonymous)
	r.Post("/auth/signin/google", h.signinGoogle)
	r.Post("/auth/signin/apple", h.signinApple)
	r.With(rateLimitPerIP(otpRequestLimiter)).
		Post("/auth/signin/email/request", otp.request)
	r.With(rateLimitPerIP(otpVerifyLimiter)).
		Post("/auth/signin/email/verify", otp.verify)
	r.Post("/auth/refresh", h.refresh)

	r.Group(func(r chi.Router) {
		r.Use(requireBearer(d.Verifier))
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

// AttachInternalGrant adds the internal subscription-grant endpoint to an
// existing router. Called from main.go only when INTERNAL_API_TOKEN is set,
// so the route is absent (chi returns 404) when the feature is disabled —
// it must not be reachable by default. Auth is the X-Internal-Token shared
// secret, not a user JWT, so the endpoint lives outside /auth/*.
func AttachInternalGrant(r http.Handler, h *InternalGrantHandler) http.Handler {
	chiR, ok := r.(chi.Router)
	if !ok {
		return r
	}
	chiR.Post("/internal/subscription/grant", h.ServeHTTP)
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
	writeJSON(w, http.StatusOK, wire.Health{
		Status: "ok",
		Build:  wire.Build{SHA: buildSHA, Time: buildTime},
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("http_response_encode_failed", "status", status, "err", err)
	}
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, wire.Error{Error: wire.ErrorDetail{Code: code, Message: msg}})
}
