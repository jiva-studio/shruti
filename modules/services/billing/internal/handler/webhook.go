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

	"github.com/jiva-studio/shruti/billing/internal/application/ipn"
	"github.com/jiva-studio/shruti/billing/internal/wire"
)

// paymentoWebhook handles Paymento's IPN. It verifies the HMAC over the RAW
// body, then hands the notification to the ipn use case.
//
// It answers 200 to every signed notification — a transiently failed order is
// left for the reconcile loop rather than asking Paymento to redeliver.
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

	var p wire.PaymentoIPN
	if err := json.Unmarshal(body, &p); err != nil {
		slog.WarnContext(ctx, "billing_webhook_bad_body", "err", err.Error())
		writeJSON(w, http.StatusOK, wire.WebhookAck{OK: false})
		return
	}

	switch h.IPN.Handle(ctx, ipn.Notification{PaymentID: p.PaymentID, OrderID: p.OrderID, OrderStatus: p.OrderStatus}) {
	case ipn.Duplicate:
		writeJSON(w, http.StatusOK, wire.WebhookAck{OK: true, Duplicate: true})
	case ipn.Unusable:
		writeJSON(w, http.StatusOK, wire.WebhookAck{OK: false})
	default:
		writeJSON(w, http.StatusOK, wire.WebhookAck{OK: true})
	}
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
