package application_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

// fakeRC answers GetSubscriber per customer id and records what was fetched.
type fakeRC struct {
	mu      sync.Mutex
	answers map[string]rcAnswer
	fetched []string
}

type rcAnswer struct {
	resp *subscription.Customer
	err  error
}

func (f *fakeRC) GetSubscriber(_ context.Context, appUserID string) (*subscription.Customer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetched = append(f.fetched, appUserID)
	a, ok := f.answers[appUserID]
	if !ok {
		return nil, fmt.Errorf("fakeRC: no answer for %q", appUserID)
	}
	return a.resp, a.err
}

func (f *fakeRC) GrantPromotional(context.Context, string, string, int64) error {
	return errors.New("fakeRC: grant not expected")
}

func (f *fakeRC) fetchedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fetched...)
}

// countingMetrics counts the RevenueCat outcomes reported through the port.
type countingMetrics struct {
	authFailed, rateLimited, permanent, unresolved atomic.Int64
}

func (m *countingMetrics) APIAuthFailed()              { m.authFailed.Add(1) }
func (m *countingMetrics) APIRateLimited()             { m.rateLimited.Add(1) }
func (m *countingMetrics) APIPermanent()               { m.permanent.Add(1) }
func (m *countingMetrics) WebhookPermanentUnresolved() { m.unresolved.Add(1) }

func proCustomer() *subscription.Customer {
	exp := time.Now().UTC().Add(30 * 24 * time.Hour)
	return &subscription.Customer{
		RequestDateMs: time.Now().UnixMilli(),
		Subscriber: &subscription.Subscriber{
			OriginalAppUserID: "orig",
			Entitlements:      map[string]subscription.Entitlement{"pro": {ExpiresDate: &exp}},
		},
	}
}

func freeCustomer() *subscription.Customer {
	return &subscription.Customer{
		RequestDateMs: time.Now().UnixMilli(),
		Subscriber:    &subscription.Subscriber{OriginalAppUserID: "orig"},
	}
}

func bootDelivery(t *testing.T, answers map[string]rcAnswer) (*Service, *fakeRC, *countingMetrics) {
	t.Helper()
	svc := bootSubscription(t)
	rc := &fakeRC{answers: answers}
	m := &countingMetrics{}
	svc.RC = rc
	svc.RCMetrics = m
	return svc, rc, m
}

func seedRCUser(t *testing.T, svc *Service, appUserID, tier string) string {
	t.Helper()
	var id string
	if err := svc.Pool.QueryRow(t.Context(),
		`INSERT INTO auth.users(rc_app_user_id, tier, tier_expires_at)
		 VALUES ($1, $2, CASE WHEN $2 = 'pro' THEN now() + interval '30 days' END)
		 RETURNING id`, appUserID, tier,
	).Scan(&id); err != nil {
		t.Fatalf("seed user %s: %v", appUserID, err)
	}
	return id
}

func tierOf(t *testing.T, svc *Service, userID string) string {
	t.Helper()
	var tier string
	if err := svc.Pool.QueryRow(t.Context(), `SELECT tier FROM auth.users WHERE id = $1`, userID).Scan(&tier); err != nil {
		t.Fatalf("read tier: %v", err)
	}
	return tier
}

type eventRow struct {
	found     bool
	appUserID string
	processed bool
	errMsg    string
}

func eventOf(t *testing.T, svc *Service, eventID string) eventRow {
	t.Helper()
	var (
		r           eventRow
		processedAt *time.Time
		errMsg      *string
	)
	err := svc.Pool.QueryRow(t.Context(),
		`SELECT app_user_id, processed_at, error FROM auth.rc_webhook_events WHERE event_id = $1`, eventID,
	).Scan(&r.appUserID, &processedAt, &errMsg)
	if errors.Is(err, pgx.ErrNoRows) {
		return r
	}
	if err != nil {
		t.Fatalf("read event %s: %v", eventID, err)
	}
	r.found = true
	r.processed = processedAt != nil
	if errMsg != nil {
		r.errMsg = *errMsg
	}
	return r
}

func outboxRows(t *testing.T, svc *Service, sourceEventID string) int {
	t.Helper()
	var n int
	if err := svc.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM app.outbox WHERE event_type = 'subscription.changed' AND source_event_id = $1`,
		sourceEventID,
	).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return n
}

// failOn makes every statement of kind op ("INSERT" or "UPDATE") on table
// raise, so a store call through it fails the way a database outage does.
func failOn(t *testing.T, svc *Service, table, op string) {
	t.Helper()
	ctx := t.Context()
	if _, err := svc.Pool.Exec(ctx, `CREATE OR REPLACE FUNCTION public.fail_statement() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`); err != nil {
		t.Fatalf("create failing function: %v", err)
	}
	if _, err := svc.Pool.Exec(ctx, fmt.Sprintf(
		`CREATE TRIGGER fail_%s BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION public.fail_statement()`,
		strings.ToLower(op), op, table,
	)); err != nil {
		t.Fatalf("create failing trigger: %v", err)
	}
}

func TestHandleDeliveryAppliesRefetchedState(t *testing.T) {
	svc, rc, _ := bootDelivery(t, map[string]rcAnswer{"rc-buyer": {resp: proCustomer()}})
	user := seedRCUser(t, svc, "rc-buyer", "free")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-buy", Type: "INITIAL_PURCHASE", AppUserID: "rc-buyer"})

	if got != rcsync.Processed {
		t.Fatalf("outcome = %v, want Processed", got)
	}
	if tier := tierOf(t, svc, user); tier != "pro" {
		t.Errorf("tier = %q, want pro", tier)
	}
	if ev := eventOf(t, svc, "ev-buy"); !ev.processed || ev.appUserID != "rc-buyer" {
		t.Errorf("event = %+v, want processed for rc-buyer", ev)
	}
	if n := outboxRows(t, svc, "ev-buy"); n != 1 {
		t.Errorf("outbox rows = %d, want 1", n)
	}
	if ids := rc.fetchedIDs(); len(ids) != 1 || ids[0] != "rc-buyer" {
		t.Errorf("fetched %v, want [rc-buyer]", ids)
	}
}

func TestHandleDeliveryDuplicateShortCircuits(t *testing.T) {
	svc, rc, _ := bootDelivery(t, map[string]rcAnswer{"rc-dup": {resp: proCustomer()}})
	seedRCUser(t, svc, "rc-dup", "free")
	d := rcsync.Delivery{EventID: "ev-dup", Type: "RENEWAL", AppUserID: "rc-dup"}

	if got := svc.HandleDelivery(t.Context(), d); got != rcsync.Processed {
		t.Fatalf("first delivery = %v, want Processed", got)
	}
	if got := svc.HandleDelivery(t.Context(), d); got != rcsync.Duplicate {
		t.Fatalf("second delivery = %v, want Duplicate", got)
	}
	if ids := rc.fetchedIDs(); len(ids) != 1 {
		t.Errorf("RevenueCat fetched %d times, want once", len(ids))
	}
	if n := outboxRows(t, svc, "ev-dup"); n != 1 {
		t.Errorf("outbox rows = %d, want 1", n)
	}
}

func TestHandleDeliveryTransferReconcilesIdentifiedDestination(t *testing.T) {
	svc, rc, _ := bootDelivery(t, map[string]rcAnswer{"rc-dest": {resp: proCustomer()}})
	dest := seedRCUser(t, svc, "rc-dest", "free")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{
		EventID:         "ev-transfer",
		Type:            "TRANSFER",
		TransferredFrom: []string{"$RCAnonymousID:old"},
		TransferredTo:   []string{"$RCAnonymousID:new", "rc-dest"},
	})

	if got != rcsync.Processed {
		t.Fatalf("outcome = %v, want Processed", got)
	}
	if ids := rc.fetchedIDs(); len(ids) != 1 || ids[0] != "rc-dest" {
		t.Errorf("fetched %v, want only the identified destination", ids)
	}
	if tier := tierOf(t, svc, dest); tier != "pro" {
		t.Errorf("destination tier = %q, want pro", tier)
	}
	if ev := eventOf(t, svc, "ev-transfer"); ev.appUserID != "rc-dest" || !ev.processed {
		t.Errorf("event = %+v, want processed for rc-dest", ev)
	}
}

func TestHandleDeliveryAnonymousOnlyTransferIsDeferred(t *testing.T) {
	svc, rc, _ := bootDelivery(t, nil)

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{
		EventID:       "ev-anon-transfer",
		Type:          "TRANSFER",
		TransferredTo: []string{"$RCAnonymousID:only"},
	})

	if got != rcsync.Deferred {
		t.Fatalf("outcome = %v, want Deferred", got)
	}
	ev := eventOf(t, svc, "ev-anon-transfer")
	if !ev.found || ev.processed || ev.appUserID != "$RCAnonymousID:only" {
		t.Errorf("event = %+v, want stored unprocessed under the anonymous id", ev)
	}
	if ids := rc.fetchedIDs(); len(ids) != 0 {
		t.Errorf("fetched %v, want nothing", ids)
	}
}

func TestHandleDeliveryWithoutAnyIDIsRefused(t *testing.T) {
	svc, rc, _ := bootDelivery(t, nil)

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-no-id", Type: "TRANSFER"})

	if got != rcsync.NoAppUserID {
		t.Fatalf("outcome = %v, want NoAppUserID", got)
	}
	if ev := eventOf(t, svc, "ev-no-id"); ev.found {
		t.Errorf("event stored: %+v", ev)
	}
	if ids := rc.fetchedIDs(); len(ids) != 0 {
		t.Errorf("fetched %v, want nothing", ids)
	}
}

func TestHandleDeliveryPermanentFailureLeavesEventRetryable(t *testing.T) {
	permanent := fmt.Errorf("%w: status=401 body={\"message\":\"key of ops@example.com revoked\"}", subscription.ErrPermanent)
	svc, _, m := bootDelivery(t, map[string]rcAnswer{"rc-revoked": {err: permanent}})
	user := seedRCUser(t, svc, "rc-revoked", "pro")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-revoked", Type: "CANCELLATION", AppUserID: "rc-revoked"})

	if got != rcsync.Unresolvable {
		t.Fatalf("outcome = %v, want Unresolvable", got)
	}
	ev := eventOf(t, svc, "ev-revoked")
	if ev.processed {
		t.Error("an unresolvable event was sealed processed")
	}
	if !strings.HasPrefix(ev.errMsg, "permanent: ") || strings.Contains(ev.errMsg, "ops@example.com") {
		t.Errorf("error = %q, want a sanitized message prefixed \"permanent: \"", ev.errMsg)
	}
	if tier := tierOf(t, svc, user); tier != "pro" {
		t.Errorf("tier = %q, want pro left as it was", tier)
	}
	if n := outboxRows(t, svc, "ev-revoked"); n != 0 {
		t.Errorf("outbox rows = %d, want 0", n)
	}
	if m.authFailed.Load() != 1 || m.permanent.Load() != 1 || m.unresolved.Load() != 1 {
		t.Errorf("counted authFailed=%d permanent=%d unresolved=%d, want 1 each",
			m.authFailed.Load(), m.permanent.Load(), m.unresolved.Load())
	}
}

func TestHandleDeliveryTransientFailureIsRetried(t *testing.T) {
	for _, tc := range []struct {
		name        string
		err         error
		rateLimited int64
	}{
		{"rate limited", &subscription.RateLimitError{Status: 429}, 1},
		{"server error", errors.New("rcclient: 502 Bad Gateway"), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, m := bootDelivery(t, map[string]rcAnswer{"rc-busy": {err: tc.err}})
			seedRCUser(t, svc, "rc-busy", "free")

			got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-busy", Type: "RENEWAL", AppUserID: "rc-busy"})

			if got != rcsync.RCUnavailable {
				t.Fatalf("outcome = %v, want RCUnavailable", got)
			}
			ev := eventOf(t, svc, "ev-busy")
			if ev.processed || ev.errMsg == "" || strings.HasPrefix(ev.errMsg, "permanent: ") {
				t.Errorf("event = %+v, want unprocessed with the transient error recorded", ev)
			}
			if got := m.rateLimited.Load(); got != tc.rateLimited {
				t.Errorf("rate-limited counted %d times, want %d", got, tc.rateLimited)
			}
			if m.permanent.Load() != 0 || m.unresolved.Load() != 0 {
				t.Error("a transient failure was counted as permanent")
			}
		})
	}
}

func TestHandleDeliveryUnknownSubscriberAppliesFree(t *testing.T) {
	svc, _, _ := bootDelivery(t, map[string]rcAnswer{
		"rc-unknown": {resp: &subscription.Customer{}, err: subscription.ErrSubscriberNotFound},
	})
	user := seedRCUser(t, svc, "rc-unknown", "pro")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-unknown", Type: "EXPIRATION", AppUserID: "rc-unknown"})

	if got != rcsync.Processed {
		t.Fatalf("outcome = %v, want Processed", got)
	}
	if tier := tierOf(t, svc, user); tier != "free" {
		t.Errorf("tier = %q, want free", tier)
	}
	if ev := eventOf(t, svc, "ev-unknown"); !ev.processed || ev.errMsg != "" {
		t.Errorf("event = %+v, want processed without an error", ev)
	}
}

func TestHandleDeliveryUnboundCustomerStaysUnmatched(t *testing.T) {
	svc, _, _ := bootDelivery(t, map[string]rcAnswer{"rc-unbound": {resp: proCustomer()}})

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: "ev-unbound", Type: "INITIAL_PURCHASE", AppUserID: "rc-unbound"})

	if got != rcsync.Unmatched {
		t.Fatalf("outcome = %v, want Unmatched", got)
	}
	if ev := eventOf(t, svc, "ev-unbound"); ev.processed || ev.errMsg != "no rc_app_user_id match" {
		t.Errorf("event = %+v, want unprocessed with 'no rc_app_user_id match'", ev)
	}
}

func TestHandleDeliveryTransferDowngradesIdentifiedSource(t *testing.T) {
	svc, rc, _ := bootDelivery(t, map[string]rcAnswer{
		"rc-new-owner": {resp: proCustomer()},
		"rc-old-owner": {resp: freeCustomer()},
	})
	newOwner := seedRCUser(t, svc, "rc-new-owner", "free")
	oldOwner := seedRCUser(t, svc, "rc-old-owner", "pro")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{
		EventID:         "ev-move",
		Type:            "TRANSFER",
		TransferredFrom: []string{"rc-old-owner"},
		TransferredTo:   []string{"rc-new-owner"},
	})

	if got != rcsync.Processed {
		t.Fatalf("outcome = %v, want Processed", got)
	}
	if tier := tierOf(t, svc, newOwner); tier != "pro" {
		t.Errorf("new owner tier = %q, want pro", tier)
	}
	if tier := tierOf(t, svc, oldOwner); tier != "free" {
		t.Errorf("old owner tier = %q, want free", tier)
	}
	if n := outboxRows(t, svc, "ev-move:from:rc-old-owner"); n != 1 {
		t.Errorf("source downgrade outbox rows = %d, want 1 under the synthetic event id", n)
	}
	if ids := rc.fetchedIDs(); len(ids) != 2 {
		t.Errorf("fetched %v, want both owners", ids)
	}
}

func TestHandleDeliveryFailedSourceDowngradeKeepsPrimary(t *testing.T) {
	svc, _, _ := bootDelivery(t, map[string]rcAnswer{
		"rc-new-owner": {resp: proCustomer()},
		"rc-old-owner": {err: errors.New("rcclient: 503 Service Unavailable")},
	})
	seedRCUser(t, svc, "rc-new-owner", "free")
	oldOwner := seedRCUser(t, svc, "rc-old-owner", "pro")

	got := svc.HandleDelivery(t.Context(), rcsync.Delivery{
		EventID:         "ev-move-flaky",
		Type:            "TRANSFER",
		TransferredFrom: []string{"rc-old-owner"},
		TransferredTo:   []string{"rc-new-owner"},
	})

	if got != rcsync.Processed {
		t.Fatalf("outcome = %v, want Processed: the primary apply is committed", got)
	}
	if tier := tierOf(t, svc, oldOwner); tier != "pro" {
		t.Errorf("old owner tier = %q, want pro until the stale sweep", tier)
	}
}

func TestHandleDeliveryStoreFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		table string
		op    string
		d     rcsync.Delivery
		want  rcsync.Outcome
	}{
		{"recording the delivery", "auth.rc_webhook_events", "INSERT",
			rcsync.Delivery{EventID: "ev-db", AppUserID: "rc-db"}, rcsync.RecordFailed},
		{"storing an anonymous transfer", "auth.rc_webhook_events", "INSERT",
			rcsync.Delivery{EventID: "ev-db", Type: "TRANSFER", TransferredTo: []string{"$RCAnonymousID:db"}}, rcsync.DeferFailed},
		{"applying the snapshot", "auth.users", "UPDATE",
			rcsync.Delivery{EventID: "ev-db", AppUserID: "rc-db"}, rcsync.ApplyFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, _ := bootDelivery(t, map[string]rcAnswer{"rc-db": {resp: proCustomer()}})
			seedRCUser(t, svc, "rc-db", "free")
			failOn(t, svc, tc.table, tc.op)

			if got := svc.HandleDelivery(t.Context(), tc.d); got != tc.want {
				t.Fatalf("outcome = %v, want %v", got, tc.want)
			}
			if ev := eventOf(t, svc, "ev-db"); ev.processed {
				t.Errorf("event sealed processed after a store failure: %+v", ev)
			}
		})
	}
}

// When storing the refetch failure on the event itself fails, that second
// failure is logged with the event id, and the outcome does not change.
func TestHandleDeliveryRecordErrorFailureIsLogged(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want rcsync.Outcome
	}{
		{"permanent", fmt.Errorf("%w: status=401", subscription.ErrPermanent), rcsync.Unresolvable},
		{"transient", errors.New("rcclient: 502 Bad Gateway"), rcsync.RCUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, _ := bootDelivery(t, map[string]rcAnswer{"rc-rec": {err: tc.err}})
			failOn(t, svc, "auth.rc_webhook_events", "UPDATE")
			var logs bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(prev) })

			eventID := "evt_rec_" + tc.name
			got := svc.HandleDelivery(t.Context(), rcsync.Delivery{EventID: eventID, AppUserID: "rc-rec"})

			if got != tc.want {
				t.Fatalf("outcome = %v, want %v", got, tc.want)
			}
			out := logs.String()
			if !strings.Contains(out, "rc_webhook_record_error_failed") || !strings.Contains(out, eventID) {
				t.Fatalf("RecordError failure not logged; logs:\n%s", out)
			}
		})
	}
}
