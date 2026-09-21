package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/shruti/discovery/internal/application/crawl"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// sourceView is a source plus what we know about how it is going.
type sourceView struct {
	sourceOut
	Items map[string]int `json:"items"`
	// Media says how many recordings are still offered and how many stopped
	// being — the second number is the one worth watching.
	Media map[string]int `json:"media,omitempty"`
	// Pages says how far the crawl got and how many visits came up
	// empty-handed. Empty is not failure: a menu has no files either.
	Pages    map[string]int `json:"pages"`
	LastRun  *store.Run     `json:"last_run,omitempty"`
	Schedule string         `json:"schedule"`
}

func sourcesHandler(repo *store.Repo, schedulerOn bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sources, err := repo.Sources(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		out := make([]sourceView, 0, len(sources))
		for _, s := range sources {
			view := sourceView{
				sourceOut: sourceFrom(s),
				Schedule:  scheduleWord(schedulerOn, s.Enabled),
			}
			if view.Items, err = repo.CountItems(r.Context(), s.ID); err != nil {
				writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
				return
			}
			if view.Media, err = repo.CountMediaStates(r.Context(), s.ID); err != nil {
				writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
				return
			}
			visited, empty, err := repo.PageStats(r.Context(), s.ID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
				return
			}
			view.Pages = map[string]int{"visited": visited, "empty": empty}
			runs, err := repo.Runs(r.Context(), s.ID, 1)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
				return
			}
			if len(runs) > 0 {
				view.LastRun = &runs[0]
			}
			out = append(out, view)
		}
		writeJSON(w, http.StatusOK, map[string]any{"sources": out})
	}
}

// scheduleWord says plainly whether anything will happen on its own, because
// "enabled" on the source alone does not answer that.
func scheduleWord(schedulerOn, sourceEnabled bool) string {
	switch {
	case !schedulerOn:
		return "manual — the scheduler is off"
	case !sourceEnabled:
		return "manual — this source is disabled"
	default:
		return "scheduled"
	}
}

func saveSourceHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in sourceIn
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if in.ID == "" || len(in.SeedURLs) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "id and seed_urls are required")
			return
		}
		// A typo here reads the archive the wrong way round, and the wrong way
		// stores empty answers and seals them.
		switch in.Kind {
		case "", store.KindMaterial, store.KindStated:
		default:
			writeErr(w, http.StatusBadRequest, "bad_request",
				`kind must be "material" or "stated"`)
			return
		}
		src := in.source()
		if err := repo.SaveSource(r.Context(), &src); err != nil {
			writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
			return
		}
		// Read back rather than echo. An edit that omits the credentials keeps
		// the stored ones, and SaveSource fills in defaults, so what was
		// submitted is not what the source now is.
		saved, err := repo.Source(r.Context(), src.ID)
		if err != nil || saved == nil {
			writeJSON(w, http.StatusOK, sourceFrom(src))
			return
		}
		writeJSON(w, http.StatusOK, sourceFrom(*saved))
	}
}

// runSourceHandler triggers a pass by hand. It works whether or not the
// scheduler is on: asking for a run is itself the authorization.
func runSourceHandler(repo *store.Repo, svc *crawl.Background) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_configured", "crawling is not wired")
			return
		}
		src, err := repo.Source(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		if src == nil {
			writeErr(w, http.StatusNotFound, "not_found", "no such source")
			return
		}

		opts := crawl.Options{
			DryRun: boolParam(r, "dry_run"),
			Full:   boolParam(r, "full"),
			Limit:  intParam(r, "limit", 0),
		}
		// The walk outlives this request on purpose: a backfill takes minutes,
		// and a client hanging up must not kill it half written.
		run, err := svc.Start(r.Context(), src, opts)
		if errors.Is(err, crawl.ErrAlreadyRunning) {
			writeErr(w, http.StatusConflict, "already_running",
				fmt.Sprintf("run %d is already walking this source", run.ID))
			return
		}
		if err != nil {
			writeErr(w, http.StatusBadGateway, "run_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, run)
	}
}

func runsHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		runs, err := repo.Runs(r.Context(), r.URL.Query().Get("source"), intParam(r, "limit", 20))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
	}
}

func runHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "run id must be a number")
			return
		}
		run, err := repo.Run(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		if run == nil {
			writeErr(w, http.StatusNotFound, "not_found", "no such run")
			return
		}
		writeJSON(w, http.StatusOK, run)
	}
}

// queueHandler is the "what is planned" view: how much is waiting, and what is
// next in line.
func queueHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		now := time.Now().UTC()
		depth, err := repo.QueueDepth(r.Context(), now)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		due, err := repo.DuePages(r.Context(), r.URL.Query().Get("source"), now, intParam(r, "limit", 20))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		urls := make([]string, 0, len(due))
		for _, p := range due {
			urls = append(urls, p.URL)
		}
		writeJSON(w, http.StatusOK, map[string]any{"due_now": depth, "next": urls})
	}
}

// emptyPagesHandler lists the visits that found no file, with why when there
// was a why. This is the "we were there and came away with nothing" view.
//
// ?failing=true narrows it to the pages that could not be read at all. Coming
// away empty and being refused are different things, and mixing them means a
// page failing for the fortieth time is filed alongside every menu on the site.
func emptyPagesHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		source, limit := r.URL.Query().Get("source"), intParam(r, "limit", 50)
		failingOnly := r.URL.Query().Get("failing") == "true"

		var pages []store.Page
		var err error
		if failingOnly {
			pages, err = repo.FailingPages(r.Context(), source, limit)
		} else {
			pages, err = repo.EmptyPages(r.Context(), source, limit)
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		out := make([]map[string]any, 0, len(pages))
		for _, p := range pages {
			out = append(out, map[string]any{
				"url":                  p.URL,
				"source":               p.SourceID,
				"http_status":          p.HTTPStatus,
				"error":                p.Error,
				"consecutive_failures": p.ConsecutiveFailures,
				"last_fetched_at":      p.LastFetchedAt,
				"next_check_at":        p.NextCheckAt,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"pages": out, "count": len(out)})
	}
}

func collectionsHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := repo.Collections(r.Context(), r.URL.Query().Get("source"), intParam(r, "limit", 50))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"collections": items, "count": len(items)})
	}
}

func boolParam(r *http.Request, name string) bool {
	v, err := strconv.ParseBool(r.URL.Query().Get(name))
	return err == nil && v
}

func intParam(r *http.Request, name string, def int) int {
	if v, err := strconv.Atoi(r.URL.Query().Get(name)); err == nil {
		return v
	}
	return def
}

func authorsHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authors, err := repo.Authors(r.Context(), r.URL.Query().Get("source"), intParam(r, "limit", 100))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"authors": authors, "count": len(authors)})
	}
}

// statusHandler is what the scheduler leaves behind now that it leaves no runs.
//
// Continuous work has no beginning and no end to record, so there is nothing to
// list. What there is instead is what this process has done since it started,
// and how much is still waiting. Two readings a minute apart give a rate; one
// reading says whether anything is moving at all.
func statusHandler(repo *store.Repo, counters *metrics.Counters, schedulerOn bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{
			"scheduler": schedulerOn,
			"work":      counters.Snapshot(time.Now().UTC()),
		}
		if repo != nil {
			depth, err := repo.QueueDepth(r.Context(), time.Now().UTC())
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
				return
			}
			out["queue"] = depth
		}
		writeJSON(w, http.StatusOK, out)
	}
}
