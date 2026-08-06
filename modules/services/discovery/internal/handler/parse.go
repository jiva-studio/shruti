package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"syscall"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// sourceRequest looks up a source's credentials and pace for a dry run.
func sourceRequest(ctx context.Context, repo *store.Repo, sourceID string) (fetch.Request, error) {
	if sourceID == "" || repo == nil {
		return fetch.Request{}, nil
	}
	src, err := repo.Source(ctx, sourceID)
	if err != nil {
		return fetch.Request{}, err
	}
	if src == nil {
		return fetch.Request{}, fmt.Errorf("no source %q", sourceID)
	}
	return fetch.Request{
		Headers:  src.AuthHeaders,
		MinDelay: time.Duration(src.CrawlDelayMS) * time.Millisecond,
	}, nil
}

// parseRequest asks about one address, or about a body the caller already has.
//
// Passing a body is how you iterate on extraction without fetching the same
// page again — and how you work against a site you would rather not hit twice.
type parseRequest struct {
	URL         string `json:"url,omitempty"`
	Body        string `json:"body,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	BaseURL     string `json:"base_url,omitempty"`
	// Source lends this dry run that source's credentials, which is the only
	// way to see what a page behind an account actually offers.
	Source string `json:"source,omitempty"`
}

// parseHandler runs the dry run. It writes nothing and schedules nothing, so it
// works with the scheduler off — asking about one URL is itself the
// authorization.
func parseHandler(svc *parse.Service, repo *store.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_configured", "parse is not wired")
			return
		}
		var req parseRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}

		var (
			layers *parse.Layers
			err    error
		)
		switch {
		case req.Body != "":
			base := req.BaseURL
			if base == "" {
				base = req.URL
			}
			if base == "" {
				writeErr(w, http.StatusBadRequest, "bad_request", "body needs base_url to resolve links against")
				return
			}
			layers, err = svc.Body(r.Context(), []byte(req.Body), req.ContentType, base)
		case req.URL != "":
			var want fetch.Request
			if want, err = sourceRequest(r.Context(), repo, req.Source); err != nil {
				writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
				return
			}
			layers, err = svc.URL(r.Context(), req.URL, want)
		default:
			writeErr(w, http.StatusBadRequest, "bad_request", "url or body is required")
			return
		}
		if err != nil {
			writeParseErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, layers)
	}
}

// writeParseErr keeps the politeness refusals distinguishable from ordinary
// failures: being told no by robots.txt is an answer, not a fault. Anything
// that is not the remote host's doing is ours, and says so.
func writeParseErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fetch.ErrDisallowed):
		writeErr(w, http.StatusForbidden, "disallowed", err.Error())
	case errors.Is(err, fetch.ErrRobotsUnread):
		writeErr(w, http.StatusServiceUnavailable, "robots_unread", err.Error())
	case errors.Is(err, fetch.ErrCircuitOpen):
		writeErr(w, http.StatusServiceUnavailable, "host_cooling_down", err.Error())
	case errors.Is(err, fetch.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err.Error())
	case errors.Is(err, syscall.ECONNREFUSED), errors.As(err, new(*url.Error)):
		writeErr(w, http.StatusBadGateway, "fetch_failed", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "index_failed", err.Error())
	}
}
