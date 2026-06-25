package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	logpkg "github.com/akdasa-studios/shruti/billing/internal/logging"
	"github.com/akdasa-studios/shruti/billing/internal/orders"
	"github.com/akdasa-studios/shruti/billing/internal/paymento"
)

type checkoutRequest struct {
	Plan string `json:"plan"`
	// ReturnPath is the site-relative, locale-correct success path the web
	// app wants the user redirected back to (e.g. "/en/subscribe/success").
	// Validated against an allowlist to avoid turning Paymento's ReturnUrl
	// into an open redirect; falls back to the default when absent/invalid.
	ReturnPath string `json:"returnPath"`
}

// safeReturnPath accepts only a site-relative ".../subscribe/success" path
// (single leading slash, no scheme/host) so a caller can't smuggle an
// off-site ReturnUrl. Returns "" when the path is not acceptable.
func safeReturnPath(p string) string {
	if len(p) < 2 || p[0] != '/' || strings.HasPrefix(p, "//") {
		return ""
	}
	if strings.ContainsAny(p, " \t\r\n") || strings.Contains(p, "..") {
		return ""
	}
	if !strings.HasSuffix(p, "/subscribe/success") {
		return ""
	}
	return p
}

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
	claims, err := h.Verifier.Verify(tok)
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

	// Per-user rate limit (falls back to IP if userID somehow empty).
	if !h.checkoutLimiter.allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many checkout attempts; retry later")
		return
	}

	var req checkoutRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if !orders.ValidPlan(req.Plan) {
		writeErr(w, http.StatusBadRequest, "bad_plan", "plan must be 'monthly' or 'yearly'")
		return
	}
	if !h.Paymento.Configured() {
		writeErr(w, http.StatusServiceUnavailable, "paymento_unconfigured", "payments are not available")
		return
	}

	amountCents, _ := orders.PriceCents(req.Plan)
	order, err := h.Repo.CreateOrder(ctx, userID, req.Plan, amountCents)
	if err != nil {
		slog.ErrorContext(ctx, "billing_create_order_failed", "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "could not create order")
		return
	}

	successPath := "/subscribe/success"
	if p := safeReturnPath(req.ReturnPath); p != "" {
		successPath = p
	}
	returnURL := h.PublicBaseURL + successPath + "?order=" + order.ID.String()
	token, err := h.Paymento.CreatePayment(ctx,
		dollars(amountCents), "USD", returnURL, order.ID.String(),
		map[string]string{"userId": userID.String(), "plan": req.Plan}, "")
	if err != nil {
		_ = h.Repo.BumpAttempt(ctx, order.ID, "create: "+err.Error())
		if errors.Is(err, paymento.ErrNotConfigured) {
			writeErr(w, http.StatusServiceUnavailable, "paymento_unconfigured", "payments are not available")
			return
		}
		slog.ErrorContext(ctx, "billing_paymento_create_failed", "order_id", order.ID.String(), "err", err.Error())
		writeErr(w, http.StatusBadGateway, "paymento_error", "could not start payment")
		return
	}
	if err := h.Repo.SetToken(ctx, order.ID, token); err != nil {
		slog.ErrorContext(ctx, "billing_set_token_failed", "order_id", order.ID.String(), "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "could not persist payment token")
		return
	}

	slog.InfoContext(ctx, "billing_checkout_created",
		"order_id", order.ID.String(), "plan", req.Plan, "amount_cents", amountCents)
	writeJSON(w, http.StatusOK, map[string]string{
		"redirectUrl": paymento.GatewayURL(token),
	})
}

// dollars renders cents as a plain dollar string (e.g. 299 → "2.99").
func dollars(cents int) string {
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}
