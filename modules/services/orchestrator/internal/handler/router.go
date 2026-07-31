// Package handler wires HTTP routes for the orchestrator service. The ingest
// pipeline itself is broker-driven; HTTP today is health + readiness only
// (admin/status endpoints land with later issues).
package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/orchestrator/internal/store"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs -> ENVs).
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

// RouterDeps bundles everything NewRouter needs. Submitter/Jobs/Verifier are the
// ingest control plane; any of them nil (no auth key / no broker at boot) makes
// the /ingest routes report 503 while health/readiness stay up.
type RouterDeps struct {
	Pool      *pgxpool.Pool
	Submitter ingestSubmitter
	Jobs      jobReader
	Verifier  tokenVerifier
}

// NewRouter wires:
//
//	GET  /healthz                    (liveness)
//	GET  /readyz                     (gates traffic until migrations are current)
//	POST /orchestrator/ingest        (submit a lecture for ingest; returns job id + state)
//	GET  /orchestrator/ingest/{id}   (live job status for the owner)
//
// The client-facing routes carry the `/orchestrator` prefix: the Caddy edge
// routes `/orchestrator/*` to this service (no strip, mirroring `/profile/*` →
// profile), so the service owns its own namespace and future orchestrator
// endpoints slot in under the same prefix.
func NewRouter(d RouterDeps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/healthz", healthz)
	r.Get("/readyz", readyzHandler(d.Pool))

	api := &ingestAPI{submit: d.Submitter, jobs: d.Jobs, verifier: d.Verifier}
	r.Route("/orchestrator", func(r chi.Router) {
		r.Post("/ingest", api.create)
		r.Get("/ingest/{id}", api.status)
	})

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

// readyzHandler reports 200 only when every embedded migration has been applied
// — the edge gates traffic on this until the schema is current.
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
