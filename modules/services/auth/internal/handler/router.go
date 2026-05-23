// Package handler wires HTTP routes for the auth service.
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/service"
)

// NewRouter wires every /auth/* endpoint.
//
// If svc is nil the router still serves /auth/healthz (boot probe before deps
// are wired).
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

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
