package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jiva-studio/shruti/billing/internal/application/checkout"
	"github.com/jiva-studio/shruti/billing/internal/wire"
	logpkg "github.com/jiva-studio/shruti/logging"
)

// checkout starts a Paymento payment for a signed-in user.
//
// Auth: a valid RS256 user access token (aud "chat"). Anonymous tokens are
// rejected — only signed-in users may buy. The user id comes from `sub`.
func (h *BillingHandler) checkout(w http.ResponseWriter, r *http.Request) {
	tok := extractBearer(r)
	if tok == "" {
		writeErr(w, http.StatusUnauthorized, "missing_token", "Authorization header required")
		return
	}
	claims, err := h.Verifier.VerifyAccess(tok)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_token", err.Error())
		return
	}
	if claims.Anonymous {
		writeErr(w, http.StatusForbidden, "anonymous_forbidden", "sign in to purchase")
		return
	}
	userID, err := claims.UserID()
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_token", err.Error())
		return
	}
	ctx := logpkg.WithUserID(r.Context(), userID.String())

	if !h.checkoutLimiter.allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many checkout attempts; retry later")
		return
	}

	var req wire.CheckoutRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}

	redirectURL, err := h.Checkout.Start(ctx, userID, req.Plan, req.ReturnPath)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, wire.CheckoutResponse{RedirectURL: redirectURL})
	case errors.Is(err, checkout.ErrUnknownPlan):
		writeErr(w, http.StatusBadRequest, "bad_plan", "plan must be 'monthly' or 'yearly'")
	case errors.Is(err, checkout.ErrPaymentsUnavailable):
		writeErr(w, http.StatusServiceUnavailable, "paymento_unconfigured", "payments are not available")
	case errors.Is(err, checkout.ErrStoreOrder):
		writeErr(w, http.StatusInternalServerError, "db_error", "could not create order")
	case errors.Is(err, checkout.ErrGateway):
		writeErr(w, http.StatusBadGateway, "paymento_error", "could not start payment")
	case errors.Is(err, checkout.ErrStoreToken):
		writeErr(w, http.StatusInternalServerError, "db_error", "could not persist payment token")
	default:
		writeErr(w, http.StatusInternalServerError, "internal_error", "could not start checkout")
	}
}
