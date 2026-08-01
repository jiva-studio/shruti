package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/lectorium/orchestrator/internal/application/runingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
)

// ingestSubmitter creates/dedups/restarts a job from an API submission,
// verifying the token itself and keying on the verified subject.
type ingestSubmitter interface {
	Submit(ctx context.Context, req ingest.Request) (runingest.SubmitResult, error)
}

// jobReader loads a job for a status read.
type jobReader interface {
	Get(ctx context.Context, id string) (*job.Job, error)
}

// tokenVerifier resolves the caller's subject from the bearer token (pro is
// ignored on a status read — you can watch your own job regardless of tier).
type tokenVerifier interface {
	VerifyPro(token string) (userID string, pro bool, err error)
}

// ingestAPI serves the client-facing ingest control plane: submit a lecture for
// ingest and poll its live status. It is the single client→server entry to the
// pipeline (the chat transport is retired) and reads job state straight from the
// orchestrator's store, so a card can show a live spinner without waiting on the
// library sync. Any dependency being nil means the service booted without auth
// or a broker, so the routes report 503 rather than half-working.
type ingestAPI struct {
	submit   ingestSubmitter
	jobs     jobReader
	verifier tokenVerifier
}

// runBody is the POST /run request — one generic entry for every orchestrated
// operation. `op` selects the task ("ingest" | "translate"; empty = ingest).
// Ingest reads url/title/author/translate_langs; translate reads membership_id
// (the track's library row) + track/source_lang/target_lang.
type runBody struct {
	Op             string   `json:"op,omitempty"`
	URL            string   `json:"url,omitempty"`
	Title          string   `json:"title,omitempty"`
	Author         string   `json:"author,omitempty"`
	TranslateLangs []string `json:"translate_langs,omitempty"`
	MembershipID   string   `json:"membership_id,omitempty"`
	Track          string   `json:"track,omitempty"`
	SourceLang     string   `json:"source_lang,omitempty"`
	TargetLang     string   `json:"target_lang,omitempty"`
}

// run handles POST /run: verify pro (inside Submit), create/dedup/restart the run
// keyed on the verified subject, and return the run id + membership id + state so
// the client can render a pending card / spinner and poll it.
func (a *ingestAPI) run(w http.ResponseWriter, r *http.Request) {
	if a == nil || a.submit == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_configured", "orchestrator api unavailable")
		return
	}
	token := bearerToken(r)
	if token == "" {
		writeErr(w, http.StatusUnauthorized, "missing_token", "bearer token required")
		return
	}
	var body runBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	if body.Op == "" {
		body.Op = job.OpIngest
	}
	switch body.Op {
	case job.OpIngest:
		if strings.TrimSpace(body.URL) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "url is required")
			return
		}
	case job.OpTranslate:
		if body.MembershipID == "" || body.TargetLang == "" || strings.TrimSpace(body.Track) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "membership_id, track and target_lang are required")
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "bad_request", "unknown op")
		return
	}
	res, err := a.submit.Submit(r.Context(), ingest.Request{
		Op:             body.Op,
		URL:            strings.TrimSpace(body.URL),
		Title:          body.Title,
		Author:         body.Author,
		TranslateLangs: body.TranslateLangs,
		MembershipID:   body.MembershipID,
		Track:          strings.TrimSpace(body.Track),
		SourceLang:     body.SourceLang,
		TargetLang:     body.TargetLang,
		Token:          token,
	})
	if errors.Is(err, runingest.ErrNotPro) {
		writeErr(w, http.StatusPaymentRequired, "not_pro", "this action requires an active pro subscription")
		return
	}
	if errors.Is(err, runingest.ErrMembershipNotFound) {
		writeErr(w, http.StatusNotFound, "not_found", "no such track")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "submit_failed", "could not submit run")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"run_id":        res.JobID,
		"membership_id": res.MembershipID,
		"state":         runingest.StatusLabel(res.State),
	})
}

// status handles GET /ingest/{id}: resolve the caller from the token and return
// the job's live status — but only to its owner. A job that is missing OR owned
// by someone else returns 404 identically, so the endpoint never reveals that a
// job id exists for another user.
func (a *ingestAPI) status(w http.ResponseWriter, r *http.Request) {
	if a == nil || a.jobs == nil || a.verifier == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_configured", "ingest api unavailable")
		return
	}
	token := bearerToken(r)
	if token == "" {
		writeErr(w, http.StatusUnauthorized, "missing_token", "bearer token required")
		return
	}
	userID, _, err := a.verifier.VerifyPro(token)
	if err != nil || userID == "" {
		writeErr(w, http.StatusUnauthorized, "invalid_token", "token verification failed")
		return
	}
	id := chi.URLParam(r, "id")
	j, err := a.jobs.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", "could not load job")
		return
	}
	if j == nil || j.OwnerID != userID {
		writeErr(w, http.StatusNotFound, "not_found", "no such job")
		return
	}
	writeJSON(w, http.StatusOK, runingest.StatusOf(j))
}

// bearerToken pulls the raw JWT from an "Authorization: Bearer <token>" header.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(h) > len(p) && strings.EqualFold(h[:len(p)], p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}
