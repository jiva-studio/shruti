package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/wire"
)

type emailOTPHandler struct {
	codes *emailotp.Service
}

// request sends a one-time sign-in code to the given email. It answers 200
// whether or not an account exists (one flow for sign-up and sign-in), so
// it cannot be used to probe which addresses are registered.
func (h *emailOTPHandler) request(w http.ResponseWriter, r *http.Request) {
	var body wire.EmailCodeRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	err := h.codes.Request(r.Context(), body.Email, body.Locale)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, wire.Empty{})
	case errors.Is(err, emailotp.ErrEmailInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_email", "a valid email is required")
	case errors.Is(err, emailotp.ErrEmailDisabled):
		writeErr(w, http.StatusServiceUnavailable, "email_disabled", "email sign-in is not configured")
	case errors.Is(err, emailotp.ErrOTPThrottled):
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusTooManyRequests, "otp_throttled", "a code was just sent; try again shortly")
	default:
		slog.ErrorContext(r.Context(), "otp_request_failed", slog.String("error", err.Error()))
		writeErr(w, http.StatusInternalServerError, "otp_request_failed", err.Error())
	}
}

// verify exchanges a valid code for a session. An anonymous bearer in the
// request upgrades that device's user, as a social sign-in does.
func (h *emailOTPHandler) verify(w http.ResponseWriter, r *http.Request) {
	var body wire.EmailCodeVerifyRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Code == "" {
		writeErr(w, http.StatusBadRequest, "missing_code", "code is required")
		return
	}
	in := signin.Input{
		DeviceID:     body.DeviceID,
		BearerAccess: extractBearer(r),
	}
	sess, err := h.codes.Verify(r.Context(), body.Email, body.Code, in)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, sessionResponse(sess))
	case errors.Is(err, emailotp.ErrEmailInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_email", "a valid email is required")
	case errors.Is(err, emailotp.ErrOTPInvalid):
		writeErr(w, http.StatusUnauthorized, "otp_invalid", "invalid or expired code")
	default:
		slog.ErrorContext(r.Context(), "otp_verify_failed", slog.String("error", err.Error()))
		writeErr(w, http.StatusInternalServerError, "otp_verify_failed", err.Error())
	}
}
