package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/akdasa-studios/shruti/billing/internal/orders"
)

// Paymento IPN OrderStatus numeric codes.
const (
	ipnInitialize       = 0
	ipnPending          = 1
	ipnPartialPaid      = 2
	ipnWaitingToConfirm = 3
	ipnTimeout          = 4
	ipnUserCanceled     = 5
	ipnPaid             = 7
	ipnApprove          = 8
	ipnReject           = 9
)

type ipnPayload struct {
	Token          string `json:"Token"`
	PaymentID      string `json:"PaymentId"`
	OrderID        string `json:"OrderId"`
	OrderStatus    int    `json:"OrderStatus"`
	AdditionalData any    `json:"AdditionalData"`
}

// paymentoWebhook handles Paymento's IPN. It verifies the HMAC over the RAW
// body, then drives the order. The IPN is only a nudge: we always call Paymento
// /payment/verify inside the driver before granting (verify-before-fulfill).
//
// We always return 200 to ack — leaving a transiently-failed order for the
// reconcile worker rather than asking Paymento to redeliver. Duplicate IPNs are
// idempotent: an order already fulfilled is a no-op (the UNIQUE
// paymento_payment_id also forecloses double-grant).
func (h *BillingHandler) paymentoWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if h.HMACSecret == "" {
		writeErr(w, http.StatusServiceUnavailable, "webhook_unconfigured", "webhook secret not set")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return
	}
	if !verifyHMAC(body, r.Header.Get("X-HMAC-SHA256-SIGNATURE"), h.HMACSecret) {
		slog.WarnContext(ctx, "billing_webhook_bad_signature")
		writeErr(w, http.StatusUnauthorized, "bad_signature", "invalid signature")
		return
	}

	var p ipnPayload
	if err := json.Unmarshal(body, &p); err != nil {
		slog.WarnContext(ctx, "billing_webhook_bad_body", "err", err.Error())
		writeJSON(w, http.StatusOK, map[string]bool{"ok": false})
		return
	}

	// Idempotency: a duplicate IPN for an already-fulfilled payment is a no-op.
	if p.PaymentID != "" {
		if o, err := h.Repo.GetByPaymentID(ctx, p.PaymentID); err == nil && o.Status == orders.StatusFulfilled {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "duplicate": true})
			return
		}
	}

	orderID, err := uuid.Parse(p.OrderID)
	if err != nil {
		slog.WarnContext(ctx, "billing_webhook_bad_order_id", "order_id", p.OrderID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": false})
		return
	}

	slog.InfoContext(ctx, "billing_webhook_received",
		"order_id", p.OrderID, "ipn_status", p.OrderStatus, "payment_id", p.PaymentID)

	// Drive the order regardless of the IPN's numeric status — the driver
	// re-verifies with Paymento authoritatively. Statuses like Approve/Paid
	// trigger a verify; terminal-negative statuses simply won't pass verify
	// and the order stays put for reconcile. A driver error is swallowed
	// (logged) so we still ack 200 and let reconcile retry.
	switch p.OrderStatus {
	case ipnTimeout, ipnUserCanceled, ipnReject:
		slog.InfoContext(ctx, "billing_webhook_negative_status",
			"order_id", p.OrderID, "ipn_status", p.OrderStatus)
	default:
		if err := h.Driver.Drive(ctx, orderID); err != nil {
			slog.WarnContext(ctx, "billing_webhook_drive_failed",
				"order_id", p.OrderID, "err", err.Error())
		}
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// verifyHMAC compares the UPPERCASE-hex HMAC_SHA256(rawBody, secret) against the
// header in constant time.
func verifyHMAC(body []byte, sigHeader, secret string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := strings.ToUpper(hex.EncodeToString(mac.Sum(nil)))
	got := strings.ToUpper(strings.TrimSpace(sigHeader))
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}
