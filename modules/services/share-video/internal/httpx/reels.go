package httpx

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/shruti-share-video/internal/db"
	"github.com/akdasa-studios/shruti-share-video/internal/logx"
	"github.com/akdasa-studios/shruti-share-video/internal/types"
)

// Server holds the dependencies the reels endpoints need.
type Server struct {
	Pool             *pgxpool.Pool
	AnonPerDay       int
	SignedInPerDay   int
	OutputPrefix     string
	OutputPublicBase string
	Bucket           string
	AWSRegion        string
}

// PostReels accepts a render request, dedup-checks public.tasks by
// video_id (so a client retry doesn't double-spend quota), increments
// the daily counter, and finally INSERTs the pending task. Returns
// 200 on a cache hit that's already done, 202 on every other queued
// or pending state.
func (s *Server) PostReels(w http.ResponseWriter, r *http.Request) {
	parsed, err := parseRenderRequest(r)
	if err != nil {
		var ve *ValidationError
		if errors.As(err, &ve) {
			writeError(w, http.StatusBadRequest, ve.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user, ok := UserFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}

	// Idempotency BEFORE quota. A client retrying the same video_id
	// shouldn't burn another quota slot or create a duplicate row.
	if parsed.VideoID != "" {
		state, err := db.FindOwnTask(r.Context(), s.Pool, parsed.VideoID, user.ID)
		if err == nil {
			status := http.StatusAccepted
			if state.Status == "done" {
				status = http.StatusOK
			}
			body := reelsResponse(state)
			writeJSON(w, status, body)
			return
		} else if !errors.Is(err, db.ErrTaskNotFound) {
			logx.From(r.Context()).Error("idempotency_lookup_failed", "err", err.Error())
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
	}

	usage, err := db.IncrementAndCheck(r.Context(), s.Pool, user.ID, user.Anonymous, s.AnonPerDay, s.SignedInPerDay)
	if err != nil {
		logx.From(r.Context()).Error("usage_check_failed", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if !usage.Allowed {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":     "rate_limited",
			"limit":    usage.Limit,
			"current":  usage.Count,
			"key_type": "user",
		})
		return
	}

	videoID := parsed.VideoID
	if videoID == "" {
		videoID = uuid.NewString()
	}
	// We persist the final videoId inside the request payload too —
	// the worker reads it from there.
	requestForPayload := parsed
	requestForPayload.VideoID = videoID

	if err := db.Insert(r.Context(), s.Pool, videoID, types.TaskPayload{
		Request: requestForPayload,
		UserID:  user.ID,
	}); err != nil {
		logx.From(r.Context()).Error("task_insert_failed", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"video_id": videoID,
		"ready":    false,
	})
}

// GetReels polls a task by id. Owner-filter is enforced at the SQL
// level; mismatched ownership returns 404 (NOT 403) so existence of
// other users' video_ids cannot be probed.
func (s *Server) GetReels(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !videoIDPathRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid video_id format")
		return
	}
	user, ok := UserFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}

	state, err := db.FindOwnTask(r.Context(), s.Pool, id, user.ID)
	if errors.Is(err, db.ErrTaskNotFound) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		logx.From(r.Context()).Error("task_lookup_failed", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	status := http.StatusAccepted
	switch state.Status {
	case "done", "failed":
		status = http.StatusOK
	}
	writeJSON(w, status, reelsResponse(state))
}

// reelsResponse builds the wire body shared by POST cache-hit and GET.
func reelsResponse(state db.TaskState) map[string]any {
	out := map[string]any{
		"video_id": state.ID,
		"ready":    state.Status == "done",
	}
	if state.Result != nil && state.Result.URL != "" {
		out["url"] = state.Result.URL
	}
	if state.Error != "" {
		out["error"] = state.Error
	}
	return out
}
