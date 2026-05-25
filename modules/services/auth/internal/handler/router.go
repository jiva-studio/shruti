// Package handler wires HTTP routes for the auth service.
package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/akdasa-studios/shruti/auth/internal/jwt"
	"github.com/akdasa-studios/shruti/auth/internal/service"
)

// NewRouter wires every /auth/* endpoint.
//
// If svc is nil the router still serves /auth/healthz (boot probe before deps
// are wired). The RC webhook route is wired separately by AttachRCWebhook
// — main.go enables it only when the secret + REST API key are configured.
func NewRouter(svc *service.Service, verifier *jwt.Verifier) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/auth/healthz", healthz)

	if svc == nil {
		return r
	}

	h := &authHandler{svc: svc, verifier: verifier}

	r.Post("/auth/anonymous", h.anonymous)
	r.Post("/auth/signin/google", h.signinGoogle)
	r.Post("/auth/signin/apple", h.signinApple)
	r.Post("/auth/refresh", h.refresh)

	r.Group(func(r chi.Router) {
		r.Use(requireBearer(verifier))
		r.Post("/auth/signout", h.signout)
		r.Get("/auth/me", h.me)
		r.Post("/auth/account/delete", h.deleteAccount)
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
