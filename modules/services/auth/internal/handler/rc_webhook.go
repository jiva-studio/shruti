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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/jiva-studio/shruti/auth/internal/metrics"
	"github.com/jiva-studio/shruti/auth/internal/rcclient"
	"github.com/jiva-studio/shruti/auth/internal/service"
	"github.com/jiva-studio/shruti/auth/internal/store"
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

// rcSubscriberFetcher is the subset of rcclient the handler needs. The
// concrete *rcclient.Client satisfies it; tests inject a stub that
// returns crafted errors without spinning up an httptest.Server.
type rcSubscriberFetcher interface {
	GetSubscriber(ctx context.Context, appUserID string) (*rcclient.SubscriberResponse, error)
}

// webhookEventStore is the subset of *store.WebhookEventRepo the
// handler calls. Mocked in tests to assert the seal-with-error path
// triggers exactly once.
type webhookEventStore interface {
	RecordError(ctx context.Context, eventID, msg string) error
	MarkProcessedWithError(ctx context.Context, eventID, msg string) error
}

// rcSubscriptionApplier abstracts the bits of *service.Service the
// handler uses for the idempotency + apply flow. The DB-touching ops
// (lookup, insert, apply) sit behind small methods so tests can swap
// in an in-memory fake.
type rcSubscriptionApplier interface {
	LookupProcessed(ctx context.Context, eventID string) (bool, error)
	InsertEvent(ctx context.Context, eventID string) error
	Apply(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (uuid.UUID, bool, error)
}

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
// The Svc + RC fields keep their original concrete types for production
// wiring (main.go untouched). The Applier / Events / Fetcher fields are
// pulled from those on first use via lazy adapters — tests can set
// them directly to skip the DB.
type RCWebhookHandler struct {
	SecretPrimary   string
	SecretSecondary string
	IsProd          bool // skips environment=SANDBOX deliveries when true
	Svc             *service.Service
	RC              *rcclient.Client
	Clock           func() time.Time // injectable for tests; default time.Now

	// Test seams. nil → derive from Svc/RC via the adapters below.
	Applier rcSubscriptionApplier
	Events  webhookEventStore
	Fetcher rcSubscriberFetcher
}

// applier returns the configured Applier or a default adapter over Svc.
// Built on each call (cheap struct copy); avoids racing on lazy init.
func (h *RCWebhookHandler) applier() rcSubscriptionApplier {
	if h.Applier != nil {
		return h.Applier
	}
	return defaultApplier{svc: h.Svc}
}

func (h *RCWebhookHandler) events() webhookEventStore {
	if h.Events != nil {
		return h.Events
	}
	return h.Svc.WebhookEvents
}

func (h *RCWebhookHandler) fetcher() rcSubscriberFetcher {
	if h.Fetcher != nil {
		return h.Fetcher
	}
	return h.RC
}

// defaultApplier wraps *service.Service so the production wiring keeps
// working unchanged while tests inject a fake. Holds the same DB
// transaction semantics the handler had inline before the refactor.
type defaultApplier struct{ svc *service.Service }

func (d defaultApplier) LookupProcessed(ctx context.Context, eventID string) (bool, error) {
	var processed bool
	err := pgx.BeginFunc(ctx, d.svc.Pool, func(tx pgx.Tx) error {
		got, err := d.svc.WebhookEvents.LookupProcessed(ctx, tx, eventID)
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

func (d defaultApplier) InsertEvent(ctx context.Context, eventID string) error {
	return pgx.BeginFunc(ctx, d.svc.Pool, func(tx pgx.Tx) error {
		_, err := d.svc.WebhookEvents.Insert(ctx, tx, eventID)
		return err
	})
}

func (d defaultApplier) Apply(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (uuid.UUID, bool, error) {
	return d.svc.ApplyRCSubscriberState(ctx, eventID, snap)
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
	if processed, err := h.applier().LookupProcessed(ctx, p.Event.ID); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_lookup_failed",
			"event_id", p.Event.ID, "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "lookup failed")
		return
	} else if processed {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "duplicate": true})
		return
	}
	if err := h.applier().InsertEvent(ctx, p.Event.ID); err != nil {
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
		_ = h.events().RecordError(ctx, p.Event.ID, "empty app_user_id")
		writeErr(w, http.StatusBadRequest, "bad_request", "missing app_user_id")
		return
	}
	resp, err := h.fetcher().GetSubscriber(ctx, p.Event.AppUserID)
	if err != nil {
		// 404 is a soft success — RC creates the subscriber lazily on
		// first event, so a webhook can race ahead. Treat the empty
		// response as "no active entitlements" and let the apply path
		// write `tier=free`.
		if errors.Is(err, rcclient.ErrSubscriberNotFound) {
			slog.InfoContext(ctx, "rc_refetch_not_found",
				"event_id", p.Event.ID,
				"rc_app_user_id", p.Event.AppUserID,
			)
			// resp is the empty-but-non-nil response from rcclient;
			// fall through to the apply step.
		} else if errors.Is(err, rcclient.ErrPermanent) {
			// 401/403 / unrecognised 4xx — API key is wrong or RC has
			// permanently rejected the call. Retrying just burns more
			// quota on each RC webhook redelivery (5 retries / ~80 min)
			// and each reconcile sweep. Mark the event processed WITH
			// the error message so RC stops, page ops via the counter
			// and a 200 response.
			metrics.RCAPIPermanentTotal.Inc()
			metrics.RCAPIAuthFailedTotal.Inc()
			slog.ErrorContext(ctx, "rc_refetch_permanent_failure",
				"event_id", p.Event.ID,
				"rc_app_user_id", p.Event.AppUserID,
				"err", err.Error(),
			)
			if sealErr := h.events().MarkProcessedWithError(ctx,
				p.Event.ID, "permanent: "+err.Error()); sealErr != nil {
				slog.ErrorContext(ctx, "rc_webhook_seal_failed",
					"event_id", p.Event.ID, "err", sealErr.Error())
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": false, "permanent": true})
			return
		} else {
			// 429 (rate-limited) and 5xx fall here — both transient.
			// Leave processed_at=NULL so RC retries; bump the rate-
			// limited counter when we see it so ops have visibility.
			if errors.Is(err, rcclient.ErrRateLimited) {
				metrics.RCAPIRateLimitedTotal.Inc()
			}
			slog.ErrorContext(ctx, "rc_refetch_failed",
				"event_id", p.Event.ID, "err", err.Error())
			_ = h.events().RecordError(ctx, p.Event.ID, err.Error())
			writeErr(w, http.StatusInternalServerError, "rc_unavailable", "refetch failed")
			return
		}
	}

	snap := service.SnapshotFromRCResponse(p.Event.AppUserID, resp, h.now())
	userID, matched, err := h.applier().Apply(ctx, p.Event.ID, snap)
	if err != nil {
		slog.ErrorContext(ctx, "rc_apply_failed",
			"event_id", p.Event.ID, "err", err.Error())
		_ = h.events().RecordError(ctx, p.Event.ID, err.Error())
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
