package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/wire"
)

// rcWebhookAuthTotal counts every Bearer check on the RC webhook endpoint,
// labelled by which configured secret matched (or `invalid` if neither did).
// During a rotation we expect `secondary` to climb once the RC dashboard
// flips to the new secret — see runbooks/rc-webhook-secret-rotation.md.
var rcWebhookAuthTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "rc_webhook_auth_total",
		Help: "RevenueCat webhook Bearer-auth attempts, labelled by which secret matched (primary/secondary/invalid).",
	},
	[]string{"key"},
)

// RCWebhookHandler exposes POST /webhooks/revenuecat. Wired into the
// router only when the operator configured at least one webhook secret
// and an RC REST client.
//
// Two secrets are accepted (`SecretPrimary` and `SecretSecondary`) so the
// operator can rotate without a window of dropped deliveries: stage the new
// secret as `SecretSecondary`, flip RC's dashboard to the new value, then
// promote secondary → primary and clear secondary on the next deploy. Both
// slots are compared in constant time.
//
// Deliveries is the rcsync use case; IsProd skips environment=SANDBOX
// deliveries.
type RCWebhookHandler struct {
	SecretPrimary   string
	SecretSecondary string
	IsProd          bool
	Deliveries      interface {
		HandleDelivery(context.Context, rcsync.Delivery) rcsync.Outcome
	}
}

// ServeHTTP answers 200 to what RevenueCat must not retry (a malformed body,
// a missing event id, a sandbox delivery in prod), 401 to a bad secret, and
// otherwise what the use case's outcome maps to.
func (h *RCWebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if !h.checkBearer(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "bad webhook secret")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return
	}
	var p wire.RevenueCatWebhook
	if err := json.Unmarshal(body, &p); err != nil {
		slog.WarnContext(ctx, "rc_webhook_bad_body", "err", err.Error())
		writeJSON(w, http.StatusOK, wire.Ack{})
		return
	}
	if p.Event.ID == "" {
		slog.WarnContext(ctx, "rc_webhook_no_event_id")
		writeJSON(w, http.StatusOK, wire.Ack{})
		return
	}
	if h.IsProd && strings.EqualFold(p.Event.Environment, "SANDBOX") {
		slog.InfoContext(ctx, "rc_webhook_skip_sandbox", "event_id", p.Event.ID)
		writeJSON(w, http.StatusOK, wire.Ack{OK: true, Skipped: true})
		return
	}

	outcome := h.Deliveries.HandleDelivery(ctx, rcsync.Delivery{
		EventID:         p.Event.ID,
		Type:            p.Event.Type,
		AppUserID:       p.Event.AppUserID,
		TransferredFrom: p.Event.TransferredFrom,
		TransferredTo:   p.Event.TransferredTo,
	})
	writeOutcome(w, outcome)
}

// writeOutcome answers RevenueCat: 200 stops its retries, 400 drops the
// event, 500 asks for a redelivery.
func writeOutcome(w http.ResponseWriter, o rcsync.Outcome) {
	switch o {
	case rcsync.Processed:
		writeJSON(w, http.StatusOK, wire.Ack{OK: true})
	case rcsync.Duplicate:
		writeJSON(w, http.StatusOK, wire.Ack{OK: true, Duplicate: true})
	case rcsync.Deferred:
		writeJSON(w, http.StatusOK, wire.Ack{OK: true, Deferred: true})
	case rcsync.Unresolvable:
		writeJSON(w, http.StatusOK, wire.Ack{Permanent: true})
	case rcsync.NoAppUserID:
		writeErr(w, http.StatusBadRequest, "bad_request", "missing app_user_id")
	case rcsync.RCUnavailable:
		writeErr(w, http.StatusInternalServerError, "rc_unavailable", "refetch failed")
	case rcsync.Unmatched:
		writeErr(w, http.StatusInternalServerError, "unmatched", "rc_app_user_id not bound yet")
	case rcsync.DeferFailed:
		writeErr(w, http.StatusInternalServerError, "db_error", "store anon transfer failed")
	case rcsync.RecordFailed:
		writeErr(w, http.StatusInternalServerError, "db_error", "idempotency probe failed")
	case rcsync.ApplyFailed:
		writeErr(w, http.StatusInternalServerError, "db_error", "apply failed")
	}
}

func (h *RCWebhookHandler) checkBearer(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		rcWebhookAuthTotal.WithLabelValues("invalid").Inc()
		return false
	}
	token := []byte(auth[len(prefix):])

	// Constant-time compare against both slots. Skip empty secrets so an
	// unset rotation slot can't be matched by an empty Bearer value.
	if h.SecretPrimary != "" &&
		subtle.ConstantTimeCompare(token, []byte(h.SecretPrimary)) == 1 {
		rcWebhookAuthTotal.WithLabelValues("primary").Inc()
		return true
	}
	if h.SecretSecondary != "" &&
		subtle.ConstantTimeCompare(token, []byte(h.SecretSecondary)) == 1 {
		rcWebhookAuthTotal.WithLabelValues("secondary").Inc()
		return true
	}
	rcWebhookAuthTotal.WithLabelValues("invalid").Inc()
	return false
}
