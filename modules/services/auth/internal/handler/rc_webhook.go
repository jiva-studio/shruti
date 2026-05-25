package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/akdasa-studios/lectorium/auth/internal/rcclient"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
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
type RCWebhookHandler struct {
	SecretPrimary   string
	SecretSecondary string
	IsProd          bool // skips environment=SANDBOX deliveries when true
	Svc             *service.Service
	RC              *rcclient.Client
	Clock           func() time.Time // injectable for tests; default time.Now
}

// Minimal subset of the RC webhook payload we actually read. Everything
// downstream comes from the REST refetch — we don't trust event_type
// to drive state because RC's matrix of event types is large, drifts
// between SDK versions, and out-of-order delivery breaks naive
// switches.
type rcWebhookPayload struct {
	Event struct {
		ID          string `json:"id"`
		Type        string `json:"type"`
		AppUserID   string `json:"app_user_id"`
		Environment string `json:"environment"` // "SANDBOX" | "PRODUCTION"
	} `json:"event"`
}

func (h *RCWebhookHandler) now() time.Time {
	if h.Clock != nil {
		return h.Clock()
	}
	return time.Now()
}

// ServeHTTP — the single entry point. Returns:
//   - 200 fast: malformed body, missing/invalid Bearer, already-processed
//     event, environment-mismatch (we don't want RC to retry these).
//   - 500: REST refetch failed or DB UPDATE failed (RC retries on its own
//     for ~80 min; after that the reconciliation cron picks it up).
func (h *RCWebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if !h.checkBearer(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "bad webhook secret")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB cap
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "read body")
		return
	}
	var p rcWebhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		// Malformed body → 200, no retry. Log so we notice.
		slog.WarnContext(ctx, "rc_webhook_bad_body", "err", err.Error())
		writeJSON(w, http.StatusOK, map[string]bool{"ok": false})
		return
	}
	if p.Event.ID == "" {
		slog.WarnContext(ctx, "rc_webhook_no_event_id")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": false})
		return
	}
	if h.IsProd && strings.EqualFold(p.Event.Environment, "SANDBOX") {
		slog.InfoContext(ctx, "rc_webhook_skip_sandbox", "event_id", p.Event.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "skipped": true})
		return
	}

	// Idempotency: check processed_at first, INSERT if absent. Doing
	// it in two steps (rather than ON CONFLICT-and-return) lets us
	// distinguish "already done" from "first sighting OR retry of a
	// failed attempt" — the second case must continue processing,
	// otherwise a transient REST error during the first attempt would
	// leave the event stuck until the reconciliation cron.
	if processed, err := h.svcLookupProcessed(ctx, p.Event.ID); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_lookup_failed",
			"event_id", p.Event.ID, "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "lookup failed")
		return
	} else if processed {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "duplicate": true})
		return
	}
	if err := h.svcInsertEvent(ctx, p.Event.ID); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_insert_failed",
			"event_id", p.Event.ID, "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "insert failed")
		return
	}

	// REST refetch — authoritative state. Failure here leaves
	// processed_at=NULL with an error message; RC will retry the
	// webhook (and we'll fall back through the idempotency path
	// taking the "unprocessed → retry" branch).
	if p.Event.AppUserID == "" {
		_ = h.Svc.WebhookEvents.RecordError(ctx, p.Event.ID, "empty app_user_id")
		writeErr(w, http.StatusBadRequest, "bad_request", "missing app_user_id")
		return
	}
	resp, err := h.RC.GetSubscriber(ctx, p.Event.AppUserID)
	if err != nil {
		slog.ErrorContext(ctx, "rc_refetch_failed",
			"event_id", p.Event.ID, "err", err.Error())
		_ = h.Svc.WebhookEvents.RecordError(ctx, p.Event.ID, err.Error())
		writeErr(w, http.StatusInternalServerError, "rc_unavailable", "refetch failed")
		return
	}

	snap := service.SnapshotFromRCResponse(p.Event.AppUserID, resp, h.now())
	userID, matched, err := h.Svc.ApplyRCSubscriberState(ctx, p.Event.ID, snap)
	if err != nil {
		slog.ErrorContext(ctx, "rc_apply_failed",
			"event_id", p.Event.ID, "err", err.Error())
		_ = h.Svc.WebhookEvents.RecordError(ctx, p.Event.ID, err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "apply failed")
		return
	}

	slog.InfoContext(ctx, "rc_webhook_processed",
		"event_id", p.Event.ID,
		"event_type", p.Event.Type,
		"rc_app_user_id", p.Event.AppUserID,
		"user_id", userID.String(),
		"matched", matched,
		"tier", snap.Tier,
	)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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

// svcLookupProcessed and svcInsertEvent are thin wrappers so the
// handler reads at one level of abstraction. They run outside the
// outer transaction by design — the apply step does its own tx.
func (h *RCWebhookHandler) svcLookupProcessed(ctx context.Context, eventID string) (bool, error) {
	var processed bool
	err := pgx.BeginFunc(ctx, h.Svc.Pool, func(tx pgx.Tx) error {
		got, err := h.Svc.WebhookEvents.LookupProcessed(ctx, tx, eventID)
		if err != nil {
			return err
		}
		processed = got
		return nil
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return processed, nil
}

func (h *RCWebhookHandler) svcInsertEvent(ctx context.Context, eventID string) error {
	return pgx.BeginFunc(ctx, h.Svc.Pool, func(tx pgx.Tx) error {
		_, err := h.Svc.WebhookEvents.Insert(ctx, tx, eventID)
		return err
	})
}
