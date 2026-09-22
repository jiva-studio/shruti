package handler

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/profile/internal/service"
)

// InternalPurgeHandler serves POST /internal/purge — a machine-to-machine
// endpoint cleanup-worker calls when a user is deleted. It carries no user
// JWT — the caller is a service, not a person — and authenticates with the
// X-Internal-Token shared secret. profile then erases every row for that user
// in its own database. Idempotent — a retried purge is a no-op.
type InternalPurgeHandler struct {
	// Token is required in X-Internal-Token; empty closes the endpoint.
	Token string
	Svc   *service.Service
}

type internalPurgeReq struct {
	UserID string `json:"user_id"`
}

func (h *InternalPurgeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Token == "" {
		writeErr(w, http.StatusServiceUnavailable, "not_configured",
			"this endpoint requires INTERNAL_API_TOKEN")
		return
	}
	got := []byte(r.Header.Get("X-Internal-Token"))
	if subtle.ConstantTimeCompare(got, []byte(h.Token)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "bad internal token")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return
	}
	var req internalPurgeReq
	if err := json.Unmarshal(body, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "malformed json")
		return
	}
	userID, err := uuid.Parse(req.UserID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "user_id must be a uuid")
		return
	}

	ctx := r.Context()
	if err := h.Svc.Purge(ctx, userID); err != nil {
		slog.ErrorContext(ctx, "purge_failed", "user_id", userID.String(), "err", err.Error())
		writeErr(w, http.StatusServiceUnavailable, "purge_failed", "purge failed, retry")
		return
	}
	slog.InfoContext(ctx, "purge_applied", "user_id", userID.String())
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
