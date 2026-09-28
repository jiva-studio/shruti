package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/jiva-studio/shruti/profile/internal/application/cursor"
	"github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/application/push"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// maxSyncBody bounds a sync request body. The edge also caps the body; this
// is the service-side backstop so a rogue caller can't stream unbounded JSON.
const maxSyncBody = 4 << 20 // 4 MiB

type syncHandler struct {
	push   *push.UseCase
	pull   *pull.UseCase
	cursor *cursor.UseCase
}

// pushChanges — POST /profile/sync/push. user_id comes only from the JWT.
func (h *syncHandler) pushChanges(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.PushRequest
	if !decodeBody(w, r, &req) {
		return
	}
	res, err := h.push.Push(r.Context(), userID, pushRequest(req))
	if err != nil {
		writeServiceErr(w, r, "push_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, pushResponse(res))
}

// pullChanges — POST /profile/sync/pull. Returns every change since the
// request cursor, including the caller's own writes (re-apply is an idempotent
// no-op), so a device that lost its local copy recovers its own data from
// cursor 0.
func (h *syncHandler) pullChanges(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.PullRequest
	if !decodeBody(w, r, &req) {
		return
	}
	res, err := h.pull.Pull(r.Context(), userID, pull.Request{Cursor: req.Cursor, Limit: req.Limit})
	if err != nil {
		writeServiceErr(w, r, "pull_failed", err)
		return
	}
	out := wire.PullResponse{Changes: make([]wire.Change, 0, len(res.Changes)), Cursor: res.Cursor, HasMore: res.HasMore}
	for _, c := range res.Changes {
		out.Changes = append(out.Changes, wireChange(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// ackCursor — POST /profile/sync/cursor.
func (h *syncHandler) ackCursor(w http.ResponseWriter, r *http.Request) {
	userID, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_token", "no user in context")
		return
	}
	var req wire.CursorRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.cursor.Ack(r.Context(), userID, cursor.Request{DeviceID: req.DeviceID, AckedSeq: req.AckedSeq}); err != nil {
		writeServiceErr(w, r, "cursor_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, wire.OKResponse{OK: true})
}

func pushRequest(req wire.PushRequest) push.Request {
	out := push.Request{DeviceID: req.DeviceID, Changes: make([]push.Item, 0, len(req.Changes))}
	for _, it := range req.Changes {
		out.Changes = append(out.Changes, push.Item{
			Collection: it.Collection,
			DocID:      it.DocID,
			Op:         it.Op,
			Data:       it.Data,
			HLC:        it.HLC,
			BaseHLC:    it.BaseHLC,
		})
	}
	return out
}

func pushResponse(res push.Result) wire.PushResponse {
	out := wire.PushResponse{
		Applied:   make([]wire.Ref, 0, len(res.Applied)),
		Conflicts: make([]wire.Conflict, 0, len(res.Conflicts)),
	}
	for _, ref := range res.Applied {
		out.Applied = append(out.Applied, wire.Ref{Collection: ref.Collection, DocID: ref.DocID})
	}
	for _, c := range res.Conflicts {
		out.Conflicts = append(out.Conflicts, wire.Conflict{
			Collection: c.Collection,
			DocID:      c.DocID,
			Master:     wireChange(c.Master),
		})
	}
	return out
}

func wireChange(c changes.Change) wire.Change {
	return wire.Change{
		ServerSeq:  c.ServerSeq,
		Collection: c.Collection,
		DocID:      c.DocID,
		Op:         c.Op,
		Data:       c.Data,
		HLC:        c.HLC,
	}
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

// writeServiceErr maps a use-case error to an HTTP status: forbidden faults
// are 403 (with the error's stable code), validation faults are 400,
// everything else is a 500 logged with context.
func writeServiceErr(w http.ResponseWriter, r *http.Request, logMsg string, err error) {
	if f, ok := changes.AsForbidden(err); ok {
		writeErr(w, http.StatusForbidden, f.Code, f.Error())
		return
	}
	if changes.IsValidation(err) {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	slog.ErrorContext(r.Context(), logMsg, "err", err.Error())
	writeErr(w, http.StatusInternalServerError, "internal", "internal error")
}
