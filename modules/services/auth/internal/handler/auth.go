package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/service"
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
	h.signinSocial(w, r, func(ctx context.Context, in service.SocialInput) (*service.Session, error) {
		return h.svc.SigninGoogle(ctx, in)
	})
}

func (h *authHandler) signinApple(w http.ResponseWriter, r *http.Request) {
	h.signinSocial(w, r, func(ctx context.Context, in service.SocialInput) (*service.Session, error) {
		return h.svc.SigninApple(ctx, in)
	})
}

func (h *authHandler) signinSocial(
	w http.ResponseWriter,
	r *http.Request,
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
		writeErr(w, http.StatusUnauthorized, "refresh_failed", err.Error())
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
		writeErr(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}
