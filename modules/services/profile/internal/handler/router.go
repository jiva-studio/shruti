// Package handler wires HTTP routes for the profile sync service.
package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/shruti/authjwt"
	"github.com/jiva-studio/shruti/profile/internal/application/cursor"
	"github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/application/purge"
	"github.com/jiva-studio/shruti/profile/internal/application/push"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs → ENVs).
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

// SchemaChecker reports whether every embedded migration has been applied.
type SchemaChecker interface {
	SchemaReady(ctx context.Context) error
}

// RouterDeps bundles everything NewRouter needs. The sync and purge routes are
// served only when every use case is set.
type RouterDeps struct {
	Push       *push.UseCase
	Pull       *pull.UseCase
	Cursor     *cursor.UseCase
	Purge      *purge.UseCase
	Verifier   *authjwt.Verifier
	Schema     SchemaChecker
	PurgeToken string // optional X-Internal-Token guard on /internal/purge
}

// NewRouter wires every route:
//
//	POST /profile/sync/push    (bearer JWT, aud=chat)
//	POST /profile/sync/pull     (bearer JWT, aud=chat)
//	POST /profile/sync/cursor   (bearer JWT, aud=chat)
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
	r.Get("/readyz", readyzHandler(d.Schema))

	if d.Push == nil || d.Pull == nil || d.Cursor == nil || d.Purge == nil {
		return r
	}

	sh := &syncHandler{push: d.Push, pull: d.Pull, cursor: d.Cursor}
	r.Group(func(r chi.Router) {
		r.Use(requireBearer(d.Verifier))
		r.Post("/profile/sync/push", sh.pushChanges)
		r.Post("/profile/sync/pull", sh.pullChanges)
		r.Post("/profile/sync/cursor", sh.ackCursor)
	})

	ph := &internalPurgeHandler{token: d.PurgeToken, purge: d.Purge}
	r.Post("/internal/purge", ph.ServeHTTP)

	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, wire.HealthResponse{
		Build:  wire.Build{SHA: buildSHA, Time: buildTime},
		Status: "ok",
	})
}

// readyzHandler reports 200 only when every embedded migration has been
// applied — the edge gates traffic on this until the schema is current.
func readyzHandler(schema SchemaChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if schema == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_ready", "no db pool")
			return
		}
		if err := schema.SchemaReady(r.Context()); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "not_ready", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, wire.ReadyResponse{Status: "ready"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, wire.ErrorResponse{Error: wire.ErrorBody{Code: code, Message: msg}})
}
