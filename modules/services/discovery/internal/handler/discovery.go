package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/lectorium/discovery/internal/application/crawl"
	"github.com/jiva-studio/lectorium/discovery/internal/application/search"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// sourceView is a source plus what we know about how it is going.
type sourceView struct {
	store.Source
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
			// Credentials go in and never come back out.
			s.AuthHeaders = nil
			view := sourceView{Source: s, Schedule: scheduleWord(schedulerOn, s.Enabled)}
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
		var src store.Source
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&src); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if src.ID == "" || len(src.SeedURLs) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "id and seed_urls are required")
			return
		}
		if err := repo.SaveSource(r.Context(), &src); err != nil {
			writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
			return
		}
		src.AuthHeaders = nil
		writeJSON(w, http.StatusOK, src)
	}
}

// runSourceHandler triggers a pass by hand. It works whether or not the
// scheduler is on: asking for a run is itself the authorization.
func runSourceHandler(repo *store.Repo, svc *crawl.Service) http.HandlerFunc {
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
		run, err := svc.Run(r.Context(), src, opts)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "run_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, run)
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
func emptyPagesHandler(repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pages, err := repo.EmptyPages(r.Context(), r.URL.Query().Get("source"), intParam(r, "limit", 50))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "query_failed", err.Error())
			return
		}
		out := make([]map[string]any, 0, len(pages))
		for _, p := range pages {
			out = append(out, map[string]any{
				"url":             p.URL,
				"source":          p.SourceID,
				"http_status":     p.HTTPStatus,
				"error":           p.Error,
				"last_fetched_at": p.LastFetchedAt,
				"next_check_at":   p.NextCheckAt,
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

func searchHandler(svc *search.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_configured", "search is not wired")
			return
		}
		q := r.URL.Query()
		query := search.Query{
			Text:       q.Get("q"),
			Author:     q.Get("author"),
			Language:   q.Get("language"),
			Source:     q.Get("source"),
			DateFrom:   dateParam(q.Get("date_from")),
			DateTo:     dateParam(q.Get("date_to")),
			Limit:      intParam(r, "limit", 20),
			Offset:     intParam(r, "offset", 0),
			RefSource:  q.Get("ref_source"),
			RefTokens:  q.Get("ref_tokens"),
			Collection: q.Get("collection"),
		}
		// `ref=SB 1.2.10` is how a person writes it; the columns store the two
		// halves separately.
		if ref := strings.Fields(q.Get("ref")); len(ref) == 2 {
			query.RefSource, query.RefTokens = ref[0], ref[1]
		}

		hits, err := svc.Search(r.Context(), query)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "search_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"hits": hits, "count": len(hits)})
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

func dateParam(s string) *time.Time {
	if s == "" {
		return nil
	}
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil
	}
	return &d
}
