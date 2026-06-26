package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/akdasa-studios/shruti/auth/internal/service"
)

type emailOTPRequestReq struct {
	Email string `json:"email"`
	// Locale selects the email template language (e.g. "ru", "sr-Latn").
	// Optional; unknown/empty falls back to English.
	Locale string `json:"locale,omitempty"`
}

type emailOTPVerifyReq struct {
	Email    string `json:"email"`
	Code     string `json:"code"`
	DeviceID string `json:"deviceId,omitempty"`
}

// requestEmailOTP sends a one-time sign-in code to the given email.
// Responds 200 whether or not an account exists (passwordless signup+login),
// so it can't be used to probe which addresses are registered.
func (h *authHandler) requestEmailOTP(w http.ResponseWriter, r *http.Request) {
	var body emailOTPRequestReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	err := h.svc.RequestEmailOTP(r.Context(), body.Email, body.Locale)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{})
	case errors.Is(err, service.ErrEmailInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_email", "a valid email is required")
	case errors.Is(err, service.ErrEmailDisabled):
		writeErr(w, http.StatusServiceUnavailable, "email_disabled", "email sign-in is not configured")
	case errors.Is(err, service.ErrOTPThrottled):
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusTooManyRequests, "otp_throttled", "a code was just sent; try again shortly")
	default:
		slog.ErrorContext(r.Context(), "otp_request_failed", slog.String("error", err.Error()))
		writeErr(w, http.StatusInternalServerError, "otp_request_failed", err.Error())
	}
}

// verifyEmailOTP exchanges a valid code for a session. An anonymous Bearer
// in the request upgrades that device's user (mirrors social signin).
func (h *authHandler) verifyEmailOTP(w http.ResponseWriter, r *http.Request) {
	var body emailOTPVerifyReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Code == "" {
		writeErr(w, http.StatusBadRequest, "missing_code", "code is required")
		return
	}
	in := service.SocialInput{
		DeviceID:     body.DeviceID,
		BearerAccess: extractBearer(r),
	}
	session, err := h.svc.VerifyEmailOTP(r.Context(), body.Email, body.Code, in)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, sessionToResp(session))
	case errors.Is(err, service.ErrEmailInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_email", "a valid email is required")
	case errors.Is(err, service.ErrEmailDisabled):
		writeErr(w, http.StatusServiceUnavailable, "email_disabled", "email sign-in is not configured")
	case errors.Is(err, service.ErrOTPInvalid):
		writeErr(w, http.StatusUnauthorized, "otp_invalid", "invalid or expired code")
	default:
		slog.ErrorContext(r.Context(), "otp_verify_failed", slog.String("error", err.Error()))
		writeErr(w, http.StatusInternalServerError, "otp_verify_failed", err.Error())
	}
}
