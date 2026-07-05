package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/jiva-studio/shruti/profile/internal/service"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// maxSyncBody bounds a sync request body. The edge also caps the body; this
// is the service-side backstop so a rogue caller can't stream unbounded JSON.
const maxSyncBody = 4 << 20 // 4 MiB

type syncHandler struct{ svc *service.Service }

// push — POST /profile/sync/push. user_id comes only from the JWT.
func (h *syncHandler) push(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.PushRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.svc.Push(r.Context(), userID, req)
	if err != nil {
		writeServiceErr(w, r, "push_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// pull — POST /profile/sync/pull. Returns every change since the request
// cursor, including the caller's own writes (re-apply is an idempotent no-op),
// so a device that lost its local copy recovers its own data from cursor 0.
func (h *syncHandler) pull(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.PullRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.svc.Pull(r.Context(), userID, req)
	if err != nil {
		writeServiceErr(w, r, "pull_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// cursor — POST /profile/sync/cursor.
func (h *syncHandler) cursor(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.CursorRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.svc.AckCursor(r.Context(), userID, req); err != nil {
		writeServiceErr(w, r, "cursor_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// decodeBody reads a size-bounded JSON body into dst, writing a 400 on
// failure. Returns false if the caller should stop.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSyncBody))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return false
	}
	if err := json.Unmarshal(body, dst); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "malformed json")
		return false
	}
	return true
}

// writeServiceErr maps a service error to an HTTP status: validation faults
// are 400, everything else is a 500 logged with context.
func writeServiceErr(w http.ResponseWriter, r *http.Request, logMsg string, err error) {
	if service.IsValidation(err) {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	slog.ErrorContext(r.Context(), logMsg, "err", err.Error())
	writeErr(w, http.StatusInternalServerError, "internal", "internal error")
}
