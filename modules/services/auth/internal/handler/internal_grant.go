package handler

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/akdasa-studios/lectorium/auth/internal/rcclient"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
)

// InternalGrantHandler serves POST /internal/subscription/grant — a
// server-to-server endpoint that grants a RevenueCat promotional "pro"
// entitlement to a user and reflects it as tier=pro right away (RC doesn't
// webhook promo grants). Wired into the router only when an InternalToken
// is configured; the route is absent (→ 404) otherwise.
//
// Auth is a single shared secret in the X-Internal-Token header, compared
// in constant time — this is not a user JWT, it's a trusted backend caller
// (e.g. the Paymento crypto-billing webhook).
type InternalGrantHandler struct {
	Token string
	Svc   *service.Service
}

type internalGrantReq struct {
	UserID   string `json:"userId"`
	Duration string `json:"duration"`
	// GrantKey idempotency-keys the grant across re-drives (the billing order
	// id). Optional: an empty key falls back to the legacy non-idempotent path.
	GrantKey string `json:"grantKey"`
}

func (h *InternalGrantHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.checkToken(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "bad internal token")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return
	}
	var req internalGrantReq
	if err := json.Unmarshal(body, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "malformed json")
		return
	}

	userID, err := uuid.Parse(req.UserID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "userId must be a uuid")
		return
	}
	if req.Duration != "monthly" && req.Duration != "yearly" {
		writeErr(w, http.StatusBadRequest, "bad_request", "duration must be monthly or yearly")
		return
	}

	ctx := r.Context()
	if err := h.Svc.GrantAndApply(ctx, userID, req.Duration, req.GrantKey); err != nil {
		switch {
		case errors.Is(err, service.ErrGrantUserNotFound):
			writeErr(w, http.StatusNotFound, "not_found", "user not found")
		case errors.Is(err, rcclient.ErrPermanent):
			slog.ErrorContext(ctx, "internal_grant_permanent",
				"user_id", userID.String(), "err", sanitizeRCError(err))
			writeErr(w, http.StatusBadGateway, "rc_permanent", "grant rejected by RevenueCat")
		default:
			// 429 / 5xx / network / DB — transient; caller may retry.
			slog.ErrorContext(ctx, "internal_grant_transient",
				"user_id", userID.String(), "err", sanitizeRCError(err))
			writeErr(w, http.StatusServiceUnavailable, "rc_unavailable", "grant failed, retry")
		}
		return
	}

	slog.InfoContext(ctx, "internal_grant_applied",
		"user_id", userID.String(), "duration", req.Duration)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *InternalGrantHandler) checkToken(r *http.Request) bool {
	if h.Token == "" {
		return false
	}
	got := []byte(r.Header.Get("X-Internal-Token"))
	return subtle.ConstantTimeCompare(got, []byte(h.Token)) == 1
}
