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
// handler calls. Mocked in tests. The handler only records errors on
// unprocessed rows (RecordError); it never seals an event as processed
// with an error, because an event we can't authoritatively resolve must
// stay retryable.
type webhookEventStore interface {
	RecordError(ctx context.Context, eventID, msg string) error
}

// rcSubscriptionApplier abstracts the bits of *service.Service the
// handler uses for the idempotency + apply flow. The DB-touching ops
// (lookup, insert, apply) sit behind small methods so tests can swap
// in an in-memory fake.
//
// InsertOrLookup + WaitForSibling replace the old two-step lookup-then-
// insert path (plan 1.2). The new shape is atomic against concurrent RC
// retries: either we inserted (proceed to apply), or we hit a conflict
// and read back processed_at. When processed_at is still NULL the caller
// takes the per-event advisory lock until the sibling commits.
type rcSubscriptionApplier interface {
	InsertOrLookup(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error)
	WaitForSibling(ctx context.Context, eventID string) (processed bool, err error)
	Apply(ctx context.Context, eventID string, snap store.SubscriptionSnapshot) (uuid.UUID, bool, error)
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
// working unchanged while tests inject a fake.
type defaultApplier struct{ svc *service.Service }

// InsertOrLookup runs the atomic INSERT-or-conflict-and-read path inside
// its own short tx. The apply step takes a fresh tx of its own.
func (d defaultApplier) InsertOrLookup(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error) {
	err = pgx.BeginFunc(ctx, d.svc.Pool, func(tx pgx.Tx) error {
		ins, proc, e := d.svc.WebhookEvents.InsertOrLookup(ctx, tx, eventID, appUserID)
		if e != nil {
			return e
		}
		inserted, processed = ins, proc
		return nil
	})
	return inserted, processed, err
}

// WaitForSibling serialises on the event_id advisory lock until the
// concurrent attempt commits or rolls back, then re-reads processed_at.
// The lock is released on tx commit/rollback so we always exit the
// function with the lock held by no one. Returns whether the sibling
// completed the apply step (processed_at is non-NULL).
func (d defaultApplier) WaitForSibling(ctx context.Context, eventID string) (bool, error) {
	var processed bool
	err := pgx.BeginFunc(ctx, d.svc.Pool, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtext('rc-webhook'), hashtext($1))`,
			eventID,
		); e != nil {
			return e
		}
		var processedAt *time.Time
		if e := tx.QueryRow(ctx,
			`SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = $1`,
			eventID,
		).Scan(&processedAt); e != nil {
			return e
		}
		processed = processedAt != nil
		return nil
	})
	return processed, err
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
		// TRANSFER events carry no app_user_id; the entitlement moves
		// from the ids in transferred_from to the ids in transferred_to.
		TransferredFrom []string `json:"transferred_from"`
		TransferredTo   []string `json:"transferred_to"`
	} `json:"event"`
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
			if _, _, err := h.applier().InsertOrLookup(ctx, p.Event.ID, anonTarget); err != nil {
				slog.ErrorContext(ctx, "rc_webhook_store_anon_transfer_failed",
					"event_id", p.Event.ID, "err", err.Error())
				writeErr(w, http.StatusInternalServerError, "db_error", "store anon transfer failed")
				return
			}
			slog.InfoContext(ctx, "rc_webhook_anon_transfer_stored",
				"event_id", p.Event.ID, "rc_app_user_id", anonTarget)
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "deferred": true})
			return
		}
		slog.WarnContext(ctx, "rc_webhook_no_app_user_id",
			"event_id", p.Event.ID, "event_type", p.Event.Type)
		writeErr(w, http.StatusBadRequest, "bad_request", "missing app_user_id")
		return
	}

	// Idempotency: one atomic INSERT ... ON CONFLICT DO NOTHING
	// RETURNING (xmax = 0). The old two-step lookup-then-insert path
	// had a window where two concurrent RC retries could both miss
	// the row and proceed to fan-out two outbox writes.
	//
	// Outcomes:
	//   - inserted=true              → first sighting, proceed.
	//   - inserted=false, processed=true → previous attempt finished, return 200.
	//   - inserted=false, processed=false → previous attempt still in
	//     flight or crashed before MarkProcessed. Acquire the advisory
	//     lock keyed on event_id; the in-flight attempt holds it (or
	//     will release on rollback). Once we have it, re-read
	//     processed_at — if NULL we retry the apply step.
	inserted, processed, err := h.applier().InsertOrLookup(ctx, p.Event.ID, appUserID)
	if err != nil {
		slog.ErrorContext(ctx, "rc_webhook_idempotency_failed",
			"event_id", p.Event.ID, "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "db_error", "idempotency probe failed")
		return
	}
	if !inserted && processed {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "duplicate": true})
		return
	}
	if !inserted && !processed {
		// Sibling retry already mid-flight (or its tx rolled back without
		// MarkProcessed). Serialise on event_id — the lock is released
		// when the sibling commits, after which we re-read processed_at.
		// If sibling succeeded, return 200 duplicate; if it left
		// processed_at NULL we fall through and re-run the apply step.
		processedNow, err := h.applier().WaitForSibling(ctx, p.Event.ID)
		if err != nil {
			slog.ErrorContext(ctx, "rc_webhook_sibling_wait_failed",
				"event_id", p.Event.ID, "err", err.Error())
			writeErr(w, http.StatusInternalServerError, "db_error", "sibling wait failed")
			return
		}
		if processedNow {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "duplicate": true})
			return
		}
		// Fall through to re-attempt; the unique constraint on event_id
		// + the apply tx still guarantee one outbox row per event.
	}

	// REST refetch — authoritative state. Failure here leaves
	// processed_at=NULL with an error message; RC will retry the
	// webhook (and we'll fall back through the idempotency path
	// taking the "unprocessed → retry" branch).
	resp, err := h.fetcher().GetSubscriber(ctx, appUserID)
	if err != nil {
		// 404 is a soft success — RC creates the subscriber lazily on
		// first event, so a webhook can race ahead. Treat the empty
		// response as "no active entitlements" and let the apply path
		// write `tier=free`.
		switch {
		case errors.Is(err, rcclient.ErrSubscriberNotFound):
			slog.InfoContext(ctx, "rc_refetch_not_found",
				"event_id", p.Event.ID,
				"rc_app_user_id", appUserID,
			)
			// resp is the empty-but-non-nil response from rcclient;
			// fall through to the apply step.
		case errors.Is(err, rcclient.ErrPermanent):
			// 401/403 / unrecognised 4xx — API key is wrong or RC has
			// permanently rejected the call. We can NOT authoritatively
			// resolve the subscriber state, so we must NOT seal the event
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
			_ = h.events().RecordError(ctx, p.Event.ID, "permanent: "+safeErr)
			writeJSON(w, http.StatusOK, map[string]bool{"ok": false, "permanent": true})
			return
		default:
			// 429 (rate-limited) and 5xx fall here — both transient.
			// Leave processed_at=NULL so RC retries; bump the rate-
			// limited counter when we see it so ops have visibility.
			if errors.Is(err, rcclient.ErrRateLimited) {
				metrics.RCAPIRateLimitedTotal.Inc()
			}
			safeErr := sanitizeRCError(err)
			slog.ErrorContext(ctx, "rc_refetch_failed",
				"event_id", p.Event.ID, "err", safeErr)
			_ = h.events().RecordError(ctx, p.Event.ID, safeErr)
			writeErr(w, http.StatusInternalServerError, "rc_unavailable", "refetch failed")
			return
		}
	}

	snap := service.SnapshotFromRCResponse(appUserID, resp, h.now())
	userID, matched, err := h.applier().Apply(ctx, p.Event.ID, snap)
	if err != nil {
		safeErr := sanitizeRCError(err)
		slog.ErrorContext(ctx, "rc_apply_failed",
			"event_id", p.Event.ID, "err", safeErr)
		_ = h.events().RecordError(ctx, p.Event.ID, safeErr)
		writeErr(w, http.StatusInternalServerError, "db_error", "apply failed")
		return
	}
	if !matched {
		// Webhook arrived before the client called Purchases.logIn —
		// rc_app_user_id isn't bound to any auth.users row yet.
		// processed_at stays NULL (set by ApplyRCSubscriberState only
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
	// here must NOT fail the webhook (that would make RC redeliver and
	// re-apply the destination). We log and lean on the stale sweep as the
	// backstop. A distinct synthetic event_id keeps the source apply from
	// colliding with the primary event's idempotency/outbox-dedup row.
	if from := firstIdentified(p.Event.TransferredFrom); from != "" && from != appUserID {
		h.downgradeTransferSource(ctx, p.Event.ID, from)
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// downgradeTransferSource refetches the identified former owner of a
// transferred entitlement and applies the resulting (now entitlement-less)
// snapshot, flipping it to free in the same handler invocation. All
// failure modes are logged and swallowed — the caller has already
// committed the primary apply and returns 200 regardless.
func (h *RCWebhookHandler) downgradeTransferSource(ctx context.Context, eventID, fromID string) {
	resp, err := h.fetcher().GetSubscriber(ctx, fromID)
	if err != nil && !errors.Is(err, rcclient.ErrSubscriberNotFound) {
		// 404 is fine — an unknown subscriber simply has no entitlements,
		// which yields a free snapshot. Anything else (permanent / rate-
		// limited / 5xx) we just log; the stale sweep reconciles later.
		slog.WarnContext(ctx, "rc_transfer_source_refetch_failed",
			"event_id", eventID, "rc_app_user_id", fromID,
			"err", sanitizeRCError(err))
		return
	}
	snap := service.SnapshotFromRCResponse(fromID, resp, h.now())
	srcEventID := eventID + ":from:" + fromID
	srcUserID, srcMatched, err := h.applier().Apply(ctx, srcEventID, snap)
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
