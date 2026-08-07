// Package handler wires the discovery service's HTTP routes.
package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/application/crawl"
	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs -> ENVs).
var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

// RouterDeps bundles everything NewRouter needs.
type RouterDeps struct {
	Pool             *pgxpool.Pool
	Repo             *store.Repo
	Parse            *parse.Service
	Index            *index.Service
	Crawl            *crawl.Background
	Search           *search.Service
	Metrics          *metrics.Counters
	SchedulerEnabled bool
}

// NewRouter wires:
//
//	GET  /healthz                      liveness
//	GET  /readyz                       gates traffic until migrations are current
//	POST /discovery/parse              single-URL dry run; writes nothing
//	POST /discovery/items              single-URL write path
//	GET  /discovery/sources            what is configured and how it is going
//	POST /discovery/sources            add or update a source
//	POST /discovery/sources/{id}/run   start a pass by hand; returns at once
//	GET  /discovery/runs               recent passes
//	GET  /discovery/runs/{id}          one pass in detail
//	GET  /discovery/queue              what is waiting for a recheck
//	GET  /discovery/pages/empty        visits that found no file
//	GET  /discovery/collections        cycles, and which parts we have
//	GET  /discovery/authors/alike      people who may be one person
//	POST /discovery/authors/merge      make two rows one person
//	GET  /discovery/search             free text plus filters
//	GET  /discovery/status             what this process has done, and what is waiting
func NewRouter(d RouterDeps) http.Handler {
	r := chi.NewRouter()
	// The logger goes outside the recoverer, not inside it. Recovering first
	// means the panic never reaches the logger and the request is missing from
	// the log entirely; this way the caller gets a 500 carrying its request id
	// and the line that says so is written like any other.
	r.Use(requestLogger)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", healthz)
	r.Get("/readyz", readyzHandler(d.Pool))

	r.Route("/discovery", func(r chi.Router) {
		r.Post("/parse", parseHandler(d.Parse, d.Repo))
		r.Post("/items", itemsHandler(d.Index))
		r.Get("/search", searchHandler(d.Search))
		r.Get("/status", statusHandler(d.Repo, d.Metrics, d.SchedulerEnabled))

		if d.Repo == nil {
			return
		}
		r.Get("/sources", sourcesHandler(d.Repo, d.SchedulerEnabled))
		r.Post("/sources", saveSourceHandler(d.Repo))
		r.Post("/sources/{id}/run", runSourceHandler(d.Repo, d.Crawl))
		r.Get("/runs", runsHandler(d.Repo))
		r.Get("/runs/{id}", runHandler(d.Repo))
		r.Get("/queue", queueHandler(d.Repo))
		r.Get("/pages/empty", emptyPagesHandler(d.Repo))
		r.Get("/collections", collectionsHandler(d.Repo))
		r.Get("/authors", authorsHandler(d.Repo))
		r.Get("/authors/alike", alikeAuthorsHandler(d.Repo))
		r.Post("/authors/merge", mergeAuthorsHandler(d.Repo))
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
