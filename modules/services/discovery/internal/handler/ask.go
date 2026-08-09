package handler

import (
	"encoding/json"
	"net/http"

	"github.com/jiva-studio/lectorium/discovery/internal/application/ask"
)

// askRequest is a question, a filter, or both.
//
// Both directions carry the same filter. That is the point: what comes back
// enriched is what goes out next time with one field changed, so dropping a
// year does not mean rewriting the sentence and hoping it reads the same way.
type askRequest struct {
	// Query is the question in words. Optional — a request with only a filter
	// is the plain search, in a body.
	Query  string     `json:"query"`
	Filter ask.Filter `json:"filter"`
}

// askHandler answers a question written in words.
//
// It is the only search this service offers. A filter without a question is
// still a search, in a body — which is why there is no GET beside it doing the
// same work with the fields spread across a query string.
func askHandler(svc *ask.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeErr(w, http.StatusServiceUnavailable, "not_configured", "search is not wired")
			return
		}
		var req askRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if req.Query == "" && req.Filter.Empty() {
			writeErr(w, http.StatusBadRequest, "bad_request", "query or filter is required")
			return
		}
		answer, err := svc.Ask(r.Context(), req.Query, req.Filter)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "search_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, answer)
	}
}
