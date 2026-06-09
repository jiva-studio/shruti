package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
)

type authHandler struct {
	svc      *service.Service
	verifier *jwt.Verifier
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

type anonymousReq struct {
	DeviceID string `json:"deviceId"`
	Platform string `json:"platform"`
}

type signinSocialReq struct {
	IDToken  string `json:"idToken"`
	FullName string `json:"fullName,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
}

type refreshReq struct {
	RefreshToken string `json:"refreshToken"`
}

type signoutReq struct {
	RefreshToken string `json:"refreshToken"`
}

type sessionResp struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	Anonymous    bool   `json:"anonymous"`
}

func sessionToResp(s *service.Session) sessionResp {
	return sessionResp{
		AccessToken:  s.AccessToken,
		RefreshToken: s.RefreshToken,
		UserID:       s.UserID.String(),
		Anonymous:    s.Anonymous,
	}
}

// ─── Handlers ───────────────────────────────────────────────────────────────

func (h *authHandler) anonymous(w http.ResponseWriter, r *http.Request) {
	var body anonymousReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.DeviceID == "" {
		writeErr(w, http.StatusBadRequest, "missing_device_id", "deviceId is required")
		return
	}
	session, err := h.svc.Anonymous(r.Context(), body.DeviceID, extractBearer(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "anonymous_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionToResp(session))
}

func (h *authHandler) signinGoogle(w http.ResponseWriter, r *http.Request) {
	h.signinSocial(w, r, service.ProviderGoogle, func(ctx context.Context, in service.SocialInput) (*service.Session, error) {
		return h.svc.SigninGoogle(ctx, in)
	})
}

func (h *authHandler) signinApple(w http.ResponseWriter, r *http.Request) {
	h.signinSocial(w, r, service.ProviderApple, func(ctx context.Context, in service.SocialInput) (*service.Session, error) {
		return h.svc.SigninApple(ctx, in)
	})
}

func (h *authHandler) signinSocial(
	w http.ResponseWriter,
	r *http.Request,
	provider string,
	fn func(context.Context, service.SocialInput) (*service.Session, error),
) {
	var body signinSocialReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.IDToken == "" {
		writeErr(w, http.StatusBadRequest, "missing_id_token", "idToken is required")
		return
	}
	in := service.SocialInput{
		IDToken:      body.IDToken,
		FullName:     body.FullName,
		DeviceID:     body.DeviceID,
		BearerAccess: extractBearer(r),
	}
	session, err := fn(r.Context(), in)
	if err != nil {
		slog.WarnContext(r.Context(), "signin_failed", slog.String("path", r.URL.Path), slog.String("error", err.Error()))
		writeErr(w, http.StatusUnauthorized, "signin_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionToResp(session))
}

func (h *authHandler) refresh(w http.ResponseWriter, r *http.Request) {
	var body refreshReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "missing_refresh", "refreshToken is required")
		return
	}
	session, err := h.svc.Refresh(r.Context(), body.RefreshToken)
	if err != nil {
		// Only a genuinely rejected token (bad/expired/unknown/revoked)
		// is the client's cue to drop the session. A transient internal
		// failure (DB unreachable during a deploy, signer error) must be
		// 5xx so the client keeps the session and retries — otherwise a
		// brief backend blip silently logs everyone out.
		if errors.Is(err, service.ErrRefreshRejected) {
			writeErr(w, http.StatusUnauthorized, "refresh_failed", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "refresh_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionToResp(session))
}

func (h *authHandler) signout(w http.ResponseWriter, r *http.Request) {
	var body signoutReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.svc.Signout(r.Context(), body.RefreshToken); err != nil {
		writeErr(w, http.StatusInternalServerError, "signout_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (h *authHandler) me(w http.ResponseWriter, r *http.Request) {
	uid, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_user", "no user in context")
		return
	}
	me, err := h.svc.Me(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "me_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func (h *authHandler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	uid, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_user", "no user in context")
		return
	}
	if err := h.svc.DeleteAccount(r.Context(), uid); err != nil {
		// Second concurrent / repeat call: the user row is already gone,
		// so 410 Gone is the honest answer. The rate limiter blocks repeat
		// hits in normal usage; this branch covers true races and stale
		// Bearers that outlived a successful previous delete.
		if errors.Is(err, service.ErrUserAlreadyDeleted) {
			writeErr(w, http.StatusGone, "already_deleted", "account is already deleted")
			return
		}
		writeErr(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}
