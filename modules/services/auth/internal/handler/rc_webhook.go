package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/metrics"
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

// rcSubscriberFetcher refetches a RevenueCat customer.
type rcSubscriberFetcher interface {
	GetSubscriber(ctx context.Context, appUserID string) (*subscription.Customer, error)
}

// webhookEventStore records why an event failed, on unprocessed rows only.
// The handler never seals an event as processed
// with an error, because an event we can't authoritatively resolve must
// stay retryable.
type webhookEventStore interface {
	RecordError(ctx context.Context, eventID, msg string) error
}

// rcSubscriptionApplier records deliveries and applies snapshots.
//
// RecordDelivery is atomic against concurrent RC retries: either we
// inserted, or we hit a conflict and read back processed_at. Apply
// re-reads processed_at under the per-customer lock, so two in-flight
// attempts of one event write at most one outbox row.
type rcSubscriptionApplier interface {
	RecordDelivery(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error)
	Apply(ctx context.Context, eventID string, snap subscription.Snapshot) (uuid.UUID, bool, error)
}

// sanitizeRCError strips PII from an error string before it lands in
// the database or structured logs. RC bodies can carry an end-user's
// email or phone number on auth failures; we never want either in
// auth.rc_webhook_events.error_message or in stdout logs ingested by
// the log pipeline. We keep the wrapped prefix (typically
// "rcclient: <status>: <body-fragment>"), truncate to 200 chars to
// bound DB row width, then mask anything that looks like an email or
// a long digit run.
func sanitizeRCError(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	const maxLen = 200
	if len(s) > maxLen {
		s = s[:maxLen]
	}
	s = rcErrEmailRE.ReplaceAllString(s, "<email>")
	s = rcErrPhoneRE.ReplaceAllString(s, "<phone>")
	return s
}

var (
	rcErrEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	rcErrPhoneRE = regexp.MustCompile(`\+?\d{7,}`)
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
// Applier and Events are the rcsync use case; Fetcher is the RevenueCat
// client. Clock defaults to time.Now.
type RCWebhookHandler struct {
	SecretPrimary   string
	SecretSecondary string
	IsProd          bool // skips environment=SANDBOX deliveries when true
	Applier         rcSubscriptionApplier
	Events          webhookEventStore
	Fetcher         rcSubscriberFetcher
	Clock           func() time.Time
}

// recordError stores msg on the unprocessed event row. The response to RC
// does not depend on it, so a failure is logged and the event stays
// retryable either way.
func (h *RCWebhookHandler) recordError(ctx context.Context, eventID, msg string) {
	if err := h.Events.RecordError(ctx, eventID, msg); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_record_error_failed",
			"event_id", eventID, "err", err.Error())
	}
}

const anonIDPrefix = "$RCAnonymousID:"

// firstIdentified returns the first non-empty, non-anonymous id in the
// list (an id bound, or bindable, to an auth.users row), or "".
func firstIdentified(ids []string) string {
	for _, id := range ids {
		if id != "" && !strings.HasPrefix(id, anonIDPrefix) {
			return id
		}
	}
	return ""
}

// firstAnonymous returns the first $RCAnonymousID:* id in the list, or "".
func firstAnonymous(ids []string) string {
	for _, id := range ids {
		if strings.HasPrefix(id, anonIDPrefix) {
			return id
		}
	}
	return ""
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
	var p wire.RevenueCatWebhook
	if err := json.Unmarshal(body, &p); err != nil {
		// Malformed body → 200, no retry. Log so we notice.
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
	// Resolve the app_user_id we refetch + reconcile. Most events carry
	// it directly. TRANSFER events don't — the entitlement now belongs to
	// the id(s) in transferred_to, so fall back to the identified
	// (non-anonymous) destination: that's the one bound to an auth.users
	// row, and refetching it picks up the just-transferred entitlement.
	// (The identified transferred_from owner that LOST the entitlement is
	// downgraded inline after the primary apply, below.)
	appUserID := p.Event.AppUserID
	if appUserID == "" {
		appUserID = firstIdentified(p.Event.TransferredTo)
	}
	if appUserID == "" {
		// No identified id to refetch. Two sub-cases:
		//
		//  a) A TRANSFER whose every transferred_to id is still anonymous
		//     ($RCAnonymousID:*). No auth.users row owns it YET, but the
		//     client may bind it via Purchases.logIn moments later. If we
		//     400-and-forget here the entitlement is lost: there's no
		//     stored event for the orphan sweep to replay once the link
		//     materialises, and the paying user is stranded on free.
		//     Store the event keyed on the anon target id and return 200
		//     so RC stops retrying — the orphan sweep resolves it once the
		//     id binds. (Idempotency still applies on re-delivery.)
		//
		//  b) Truly nothing usable (no app_user_id, no transferred_to at
		//     all) → 400 so RC stops retrying; nothing the sweep could do.
		if anonTarget := firstAnonymous(p.Event.TransferredTo); anonTarget != "" {
			if _, _, err := h.Applier.RecordDelivery(ctx, p.Event.ID, anonTarget); err != nil {
				slog.ErrorContext(ctx, "rc_webhook_store_anon_transfer_failed",
					"event_id", p.Event.ID, "err", err.Error())
				writeErr(w, http.StatusInternalServerError, "db_error", "store anon transfer failed")
				return
			}
			slog.InfoContext(ctx, "rc_webhook_anon_transfer_stored",
				"event_id", p.Event.ID, "rc_app_user_id", anonTarget)
			writeJSON(w, http.StatusOK, wire.Ack{OK: true, Deferred: true})
			return
		}
		slog.WarnContext(ctx, "rc_webhook_no_app_user_id",
			"event_id", p.Event.ID, "event_type", p.Event.Type)
		writeErr(w, http.StatusBadRequest, "bad_request", "missing app_user_id")
		return
	}

	// Idempotency: one atomic INSERT ... ON CONFLICT DO NOTHING
	// RETURNING (xmax = 0). A lookup-then-insert would leave a window
	// where two concurrent RC retries both miss the row and fan out two
	// outbox writes.
	//
	// Outcomes:
	//   - inserted=true              → first sighting, proceed.
	//   - inserted=false, processed=true → previous attempt finished, return 200.
	//   - inserted=false, processed=false → previous attempt still in
	//     flight or failed before MarkProcessed. Run the apply step: it
	//     re-reads processed_at under the per-customer lock and the
	//     outbox dedup index keeps one row per event.
	inserted, processed, err := h.Applier.RecordDelivery(ctx, p.Event.ID, appUserID)
	if err != nil {
		slog.ErrorContext(ctx, "rc_webhook_idempotency_failed",
			"event_id", p.Event.ID, "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "idempotency probe failed")
		return
	}
	if !inserted && processed {
		writeJSON(w, http.StatusOK, wire.Ack{OK: true, Duplicate: true})
		return
	}

	// REST refetch — authoritative state. Failure here leaves
	// processed_at=NULL with an error message; RC will retry the
	// webhook (and we'll fall back through the idempotency path
	// taking the "unprocessed → retry" branch).
	fetchedAt := h.now()
	resp, err := h.Fetcher.GetSubscriber(ctx, appUserID)
	if err != nil {
		// 404 is a soft success — RC creates the subscriber lazily on
		// first event, so a webhook can race ahead. Treat the empty
		// response as "no active entitlements" and let the apply path
		// write `tier=free`.
		switch {
		case errors.Is(err, subscription.ErrSubscriberNotFound):
			slog.InfoContext(ctx, "rc_refetch_not_found",
				"event_id", p.Event.ID,
				"rc_app_user_id", appUserID,
			)
			// resp is the client's empty-but-non-nil customer;
			// fall through to the apply step.
		case errors.Is(err, subscription.ErrPermanent):
			// 401/403 / unrecognised 4xx — API key is wrong or RC has
			// permanently rejected the call. We cannot authoritatively
			// resolve the subscriber state, so we must not seal the event
			// processed: sealing freezes whatever tier the user currently
			// has, and a dropped non-time-based REVOCATION/REFUND that
			// rode in on this event would leave a cancelled user on Pro
			// indefinitely (the column never gets corrected, and the
			// reconcile cron's 24h permanent-skip suppresses the catch-up
			// fetch too).
			//
			// Instead: record the error but leave processed_at NULL. RC
			// keeps retrying within its ~80-min budget; once ops rotate
			// the key (the hard-alert counter below pages them) the next
			// RC retry — or, past the budget, the reconcile/orphan sweep —
			// resolves the real state and corrects the tier. Returning 200
			// (not 500) avoids amplifying the redelivery storm while the
			// key is broken, but the unsealed row is what guarantees the
			// correction eventually lands.
			metrics.RCAPIPermanentTotal.Inc()
			metrics.RCAPIAuthFailedTotal.Inc()
			metrics.RCWebhookPermanentUnresolvedTotal.Inc()
			safeErr := sanitizeRCError(err)
			slog.ErrorContext(ctx, "rc_refetch_permanent_failure",
				"event_id", p.Event.ID,
				"rc_app_user_id", appUserID,
				"err", safeErr,
			)
			h.recordError(ctx, p.Event.ID, "permanent: "+safeErr)
			writeJSON(w, http.StatusOK, wire.Ack{Permanent: true})
			return
		default:
			// 429 (rate-limited) and 5xx fall here — both transient.
			// Leave processed_at=NULL so RC retries; bump the rate-
			// limited counter when we see it so ops have visibility.
			if errors.Is(err, subscription.ErrRateLimited) {
				metrics.RCAPIRateLimitedTotal.Inc()
			}
			safeErr := sanitizeRCError(err)
			slog.ErrorContext(ctx, "rc_refetch_failed",
				"event_id", p.Event.ID, "err", safeErr)
			h.recordError(ctx, p.Event.ID, safeErr)
			writeErr(w, http.StatusInternalServerError, "rc_unavailable", "refetch failed")
			return
		}
	}

	snap := rcsync.SnapshotFromRCResponse(appUserID, resp, fetchedAt)
	userID, matched, err := h.Applier.Apply(ctx, p.Event.ID, snap)
	if err != nil {
		safeErr := sanitizeRCError(err)
		slog.ErrorContext(ctx, "rc_apply_failed",
			"event_id", p.Event.ID, "err", safeErr)
		h.recordError(ctx, p.Event.ID, safeErr)
		writeErr(w, http.StatusInternalServerError, "db_error", "apply failed")
		return
	}
	if !matched {
		// Webhook arrived before the client called Purchases.logIn —
		// rc_app_user_id isn't bound to any auth.users row yet.
		// processed_at stays NULL (set by rcsync.Service.Apply only
		// when matched=true) so RC keeps retrying within its 80-min
		// budget. By that point the client should have called logIn;
		// after the budget the reconciliation cron's orphan sweep
		// stamps the row processed if the link still hasn't appeared.
		slog.InfoContext(ctx, "rc_webhook_unmatched",
			"event_id", p.Event.ID,
			"event_type", p.Event.Type,
			"rc_app_user_id", appUserID,
		)
		writeErr(w, http.StatusInternalServerError, "unmatched", "rc_app_user_id not bound yet")
		return
	}

	slog.InfoContext(ctx, "rc_webhook_processed",
		"event_id", p.Event.ID,
		"event_type", p.Event.Type,
		"rc_app_user_id", appUserID,
		"user_id", userID.String(),
		"matched", matched,
		"tier", snap.Tier,
	)

	// TRANSFER source downgrade. A TRANSFER moves the entitlement from
	// transferred_from to transferred_to; we just refetched + applied the
	// destination above. If an IDENTIFIED (non-anonymous) source id lost
	// the entitlement it must be downgraded too — otherwise both the old
	// and new owner read Pro until the up-to-24h stale sweep catches the
	// source, i.e. two Pro sessions from one purchase. Do it inline.
	//
	// Best-effort: the primary event is already committed, so a failure
	// here must not fail the webhook (that would make RC redeliver and
	// re-apply the destination). We log and lean on the stale sweep as the
	// backstop. A distinct synthetic event_id keeps the source apply from
	// colliding with the primary event's idempotency/outbox-dedup row.
	if from := firstIdentified(p.Event.TransferredFrom); from != "" && from != appUserID {
		h.downgradeTransferSource(ctx, p.Event.ID, from)
	}

	writeJSON(w, http.StatusOK, wire.Ack{OK: true})
}

// downgradeTransferSource refetches the identified former owner of a
// transferred entitlement and applies the resulting (now entitlement-less)
// snapshot, flipping it to free in the same handler invocation. All
// failure modes are logged and swallowed — the caller has already
// committed the primary apply and returns 200 regardless.
func (h *RCWebhookHandler) downgradeTransferSource(ctx context.Context, eventID, fromID string) {
	fetchedAt := h.now()
	resp, err := h.Fetcher.GetSubscriber(ctx, fromID)
	if err != nil && !errors.Is(err, subscription.ErrSubscriberNotFound) {
		// 404 is fine — an unknown subscriber simply has no entitlements,
		// which yields a free snapshot. Anything else (permanent / rate-
		// limited / 5xx) we just log; the stale sweep reconciles later.
		slog.WarnContext(ctx, "rc_transfer_source_refetch_failed",
			"event_id", eventID, "rc_app_user_id", fromID,
			"err", sanitizeRCError(err))
		return
	}
	snap := rcsync.SnapshotFromRCResponse(fromID, resp, fetchedAt)
	srcEventID := eventID + ":from:" + fromID
	srcUserID, srcMatched, err := h.Applier.Apply(ctx, srcEventID, snap)
	if err != nil {
		slog.WarnContext(ctx, "rc_transfer_source_apply_failed",
			"event_id", srcEventID, "rc_app_user_id", fromID,
			"err", sanitizeRCError(err))
		return
	}
	slog.InfoContext(ctx, "rc_transfer_source_reconciled",
		"event_id", srcEventID, "rc_app_user_id", fromID,
		"user_id", srcUserID.String(), "matched", srcMatched, "tier", snap.Tier)
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
