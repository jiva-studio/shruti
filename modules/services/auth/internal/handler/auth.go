package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jiva-studio/shruti/auth/internal/application/account"
	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/wire"
)

type authHandler struct {
	sessions *session.Service
	signIn   *signin.Service
	accounts *account.Service
}

func sessionResponse(s *session.Session) wire.Session {
	return wire.Session{
		AccessToken:  s.AccessToken,
		RefreshToken: s.RefreshToken,
		UserID:       s.UserID.String(),
		Anonymous:    s.Anonymous,
	}
}

func meResponse(me profile.Me) wire.Me {
	out := wire.Me{
		UserID:        me.UserID,
		Anonymous:     me.Anonymous,
		CreatedAt:     me.CreatedAt,
		Tier:          me.Tier,
		TierExpiresAt: me.TierExpiresAt,
		Email:         me.Email,
		Name:          me.Name,
		PictureURL:    me.PictureURL,
		Identities:    make([]wire.MeIdentity, 0, len(me.Identities)),
	}
	for _, i := range me.Identities {
		out.Identities = append(out.Identities, wire.MeIdentity(i))
	}
	return out
}

// maxRequestBody bounds every JSON request body of the /auth/* endpoints.
// The largest legitimate body is a social sign-in carrying an id token of a
// few KiB.
const maxRequestBody = 64 << 10

// decodeJSON reads at most maxRequestBody bytes of JSON into dst. On failure
// it writes 413 (body too large) or 400 and returns false.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	err := json.NewDecoder(r.Body).Decode(dst)
	if err == nil {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeErr(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body exceeds 64 KiB")
		return false
	}
	writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	return false
}

func (h *authHandler) anonymous(w http.ResponseWriter, r *http.Request) {
	var body wire.AnonymousRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.DeviceID == "" {
		writeErr(w, http.StatusBadRequest, "missing_device_id", "deviceId is required")
		return
	}
	sess, err := h.signIn.Anonymous(r.Context(), body.DeviceID, extractBearer(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "anonymous_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse(sess))
}

func (h *authHandler) signinGoogle(w http.ResponseWriter, r *http.Request) {
	h.signinSocial(w, r, h.signIn.Google)
}

func (h *authHandler) signinApple(w http.ResponseWriter, r *http.Request) {
	h.signinSocial(w, r, h.signIn.Apple)
}

func (h *authHandler) signinSocial(
	w http.ResponseWriter,
	r *http.Request,
	fn func(context.Context, signin.Input) (*session.Session, error),
) {
	var body wire.SocialSigninRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.IDToken == "" {
		writeErr(w, http.StatusBadRequest, "missing_id_token", "idToken is required")
		return
	}
	in := signin.Input{
		IDToken:      body.IDToken,
		FullName:     body.FullName,
		DeviceID:     body.DeviceID,
		BearerAccess: extractBearer(r),
		Nonce:        body.Nonce,
	}
	sess, err := fn(r.Context(), in)
	if err != nil {
		slog.WarnContext(r.Context(), "signin_failed", slog.String("path", r.URL.Path), slog.String("error", err.Error()))
		writeErr(w, http.StatusUnauthorized, "signin_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse(sess))
}

func (h *authHandler) refresh(w http.ResponseWriter, r *http.Request) {
	var body wire.RefreshRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "missing_refresh", "refreshToken is required")
		return
	}
	sess, err := h.sessions.Refresh(r.Context(), body.RefreshToken)
	if err != nil {
		// Only a rejected token (bad/expired/unknown/revoked) is the
		// client's cue to drop the session. An internal failure (database
		// unreachable during a deploy, signer error) answers 5xx so the
		// client keeps the session and retries.
		if errors.Is(err, session.ErrRefreshRejected) {
			// The concrete reason separates a genuine 90-day expiry from a
			// rotation-race sign-out in aggregate logs; the access log only
			// records the 401.
			slog.WarnContext(r.Context(), "refresh_rejected", slog.String("reason", err.Error()))
			writeErr(w, http.StatusUnauthorized, "refresh_failed", err.Error())
			return
		}
		slog.ErrorContext(r.Context(), "refresh_error", slog.String("error", err.Error()))
		writeErr(w, http.StatusInternalServerError, "refresh_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse(sess))
}

func (h *authHandler) signout(w http.ResponseWriter, r *http.Request) {
	var body wire.RefreshRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := h.sessions.Signout(r.Context(), body.RefreshToken); err != nil {
		writeErr(w, http.StatusInternalServerError, "signout_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, wire.Empty{})
}

func (h *authHandler) me(w http.ResponseWriter, r *http.Request) {
	uid, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_user", "no user in context")
		return
	}
	me, err := h.accounts.Me(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "me_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, meResponse(*me))
}

func (h *authHandler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	uid, ok := userFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_user", "no user in context")
		return
	}
	if err := h.accounts.Delete(r.Context(), uid); err != nil {
		// The user row is already gone (a concurrent or repeated call, or a
		// bearer that outlived an earlier delete): 410 is the honest answer.
		if errors.Is(err, account.ErrUserAlreadyDeleted) {
			writeErr(w, http.StatusGone, "already_deleted", "account is already deleted")
			return
		}
		writeErr(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, wire.Empty{})
}
