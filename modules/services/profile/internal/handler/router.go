// Package handler wires HTTP routes for the profile sync service.
package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/jwt"
	"github.com/jiva-studio/shruti/profile/internal/service"
	"github.com/jiva-studio/shruti/profile/internal/store"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs → ENVs).
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

// RouterDeps bundles everything NewRouter needs.
type RouterDeps struct {
	Svc        *service.Service
	Verifier   *jwt.Verifier
	Pool       *pgxpool.Pool
	PurgeToken string // optional X-Internal-Token guard on /internal/purge
}

// NewRouter wires every route:
//
//	POST /profile/sync/push    (bearer JWT, non-anonymous)
//	POST /profile/sync/pull     (bearer JWT, non-anonymous)
//	POST /profile/sync/cursor   (bearer JWT, non-anonymous)
//	POST /internal/purge        (network-only, optional shared secret)
//	GET  /healthz               (liveness)
//	GET  /readyz                (gates traffic until migrations are current)
//
// /internal/purge is on the same mux/port but is never routed by the public
// edge — cleanup-worker reaches it directly at profile:8085.
func NewRouter(d RouterDeps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/healthz", healthz)
	r.Get("/readyz", readyzHandler(d.Pool))

	if d.Svc == nil {
		return r
	}

	sh := &syncHandler{svc: d.Svc}
	r.Group(func(r chi.Router) {
		r.Use(requireBearer(d.Verifier))
		r.Post("/profile/sync/push", sh.push)
		r.Post("/profile/sync/pull", sh.pull)
		r.Post("/profile/sync/cursor", sh.cursor)
	})

	purge := &InternalPurgeHandler{Token: d.PurgeToken, Svc: d.Svc}
	r.Post("/internal/purge", purge.ServeHTTP)

	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"build": map[string]string{
			"sha":  buildSHA,
			"time": buildTime,
		},
	})
}

// readyzHandler reports 200 only when every embedded migration has been
// applied — the edge gates traffic on this until the schema is current.
func readyzHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if pool == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_ready", "no db pool")
			return
		}
		if err := store.SchemaReady(r.Context(), pool); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "not_ready", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
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
