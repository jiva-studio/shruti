package handler

import (
	"encoding/json"
	"net/http"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
)

// itemsRequest asks for one URL to be processed for real.
type itemsRequest struct {
	URL string `json:"url"`
	// Source binds what is found to a source. Optional: a one-off URL belongs
	// to nobody in particular.
	Source string `json:"source,omitempty"`
	// Force refetches ignoring the stored validators and re-normalizes and
	// re-embeds even when nothing changed.
	Force bool `json:"force,omitempty"`
}

// itemsHandler is the write path for a single URL. Asking for a specific URL
// is itself the authorization, so it runs with the scheduler off.
func itemsHandler(svc *index.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_configured", "indexing is not wired")
			return
		}
		var req itemsRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if req.URL == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "url is required")
			return
		}

		report, err := svc.Item(r.Context(), req.URL, req.Source, req.Force)
		if err != nil {
			writeParseErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, report)
	}
}
