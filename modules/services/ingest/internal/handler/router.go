// Package handler wires HTTP routes for the ingest worker. The pipeline is
// broker-driven; HTTP is health + readiness only. The worker is stateless (no
// DB), so readiness reports ready as soon as the process is up.
package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs -> ENVs).
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

// RouterDeps bundles everything NewRouter needs. The stateless worker has no
// dependencies to gate readiness on today.
type RouterDeps struct{}

// NewRouter wires:
//
//	GET /healthz   (liveness)
//	GET /readyz    (readiness — always ready; the worker holds no DB schema)
func NewRouter(_ RouterDeps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/healthz", healthz)
	r.Get("/readyz", readyz)

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

// readyz reports ready unconditionally: the stateless worker has no migrations
// or external prerequisites to gate traffic on.
func readyz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
