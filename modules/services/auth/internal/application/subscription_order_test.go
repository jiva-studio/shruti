package application_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

// TestSnapshotAtIsRCTimeOnly: snapshots are ordered on RC's clock; a
// response without RC time yields no SnapshotAt rather than the local one.
func TestSnapshotAtIsRCTimeOnly(t *testing.T) {
	local := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	rc := time.Date(2026, 9, 28, 12, 0, 3, 0, time.UTC)

	snap := rcsync.SnapshotFromRCResponse("u", &subscription.Customer{RequestDateMs: rc.UnixMilli()}, local)
	if !snap.SnapshotAt.Equal(rc) {
		t.Errorf("SnapshotAt = %v, want RC request date %v", snap.SnapshotAt, rc)
	}
	snap = rcsync.SnapshotFromRCResponse("u", &subscription.Customer{}, local)
	if !snap.SnapshotAt.IsZero() {
		t.Errorf("SnapshotAt = %v, want zero without RC time", snap.SnapshotAt)
	}
	snap = rcsync.SnapshotFromRCResponse("u", nil, local)
	if !snap.SnapshotAt.IsZero() {
		t.Errorf("nil response: SnapshotAt = %v, want zero", snap.SnapshotAt)
	}
}

// TestOlderSnapshotIsNotApplied: a snapshot taken before the one already
// applied leaves tier untouched, writes no outbox row and still seals its
// webhook event so RC stops redelivering it.
func TestOlderSnapshotIsNotApplied(t *testing.T) {
	svc := bootSubscription(t)
	ctx := t.Context()

	user, err := svc.Anonymous(ctx, "dev-stale", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-stale"
	bindRCAppUserID(t, svc, user.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, "ev-new", appUserID)
	seedWebhookEvent(t, svc, "ev-old", appUserID)

	t1 := time.Now().UTC().Truncate(time.Millisecond)
	t2 := t1.Add(time.Second)
	proUntil := t1.Add(30 * 24 * time.Hour)
	newer := subscription.Snapshot{AppUserID: appUserID, Tier: account.TierFree, SnapshotAt: t2}
	older := subscription.Snapshot{AppUserID: appUserID, Tier: account.TierPro, TierExpiresAt: &proUntil, SnapshotAt: t1}

	if _, matched, err := svc.ApplyRCSubscriberState(ctx, "ev-new", newer); err != nil || !matched {
		t.Fatalf("apply newer: matched=%v err=%v", matched, err)
	}
	uid, matched, err := svc.ApplyRCSubscriberState(ctx, "ev-old", older)
	if err != nil {
		t.Fatalf("apply older: %v", err)
	}
	if !matched || uid != user.UserID {
		t.Fatalf("stale apply must still report the matched user: matched=%v uid=%s", matched, uid)
	}

	u, err := svc.Users.Get(ctx, user.UserID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u.Tier != account.TierFree {
		t.Fatalf("tier = %q, want free (older pro snapshot must not win)", u.Tier)
	}
	var snapAt time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT rc_snapshot_at FROM auth.users WHERE id = $1`, user.UserID,
	).Scan(&snapAt); err != nil {
		t.Fatalf("read rc_snapshot_at: %v", err)
	}
	if !snapAt.Equal(t2) {
		t.Errorf("rc_snapshot_at = %v, want %v", snapAt, t2)
	}

	var outboxN, pending int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.outbox WHERE event_type='subscription.changed' AND aggregate_id=$1`,
		user.UserID.String(),
	).Scan(&outboxN); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxN != 1 {
		t.Errorf("outbox rows = %d, want 1 (the stale apply changed nothing)", outboxN)
	}
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.rc_webhook_events WHERE processed_at IS NULL AND event_id IN ('ev-new','ev-old')`,
	).Scan(&pending); err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if pending != 0 {
		t.Errorf("%d events unprocessed, want 0", pending)
	}
}

// TestSnapshotWithoutTimeNeverOverridesTimedOne: an unordered snapshot
// applies only while no timed one is recorded, and never sets
// rc_snapshot_at itself.
func TestSnapshotWithoutTimeNeverOverridesTimedOne(t *testing.T) {
	svc := bootSubscription(t)
	ctx := t.Context()
	user, err := svc.Anonymous(ctx, "dev-notime", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-notime"
	bindRCAppUserID(t, svc, user.UserID.String(), appUserID)
	for _, ev := range []string{"ev-notime-1", "ev-timed", "ev-notime-2"} {
		seedWebhookEvent(t, svc, ev, appUserID)
	}

	if _, _, err := svc.ApplyRCSubscriberState(ctx, "ev-notime-1",
		subscription.Snapshot{AppUserID: appUserID, Tier: account.TierFree}); err != nil {
		t.Fatalf("apply untimed: %v", err)
	}
	var snapAt *time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT rc_snapshot_at FROM auth.users WHERE id = $1`, user.UserID,
	).Scan(&snapAt); err != nil {
		t.Fatalf("read rc_snapshot_at: %v", err)
	}
	if snapAt != nil {
		t.Fatalf("rc_snapshot_at = %v after an untimed snapshot, want NULL", *snapAt)
	}

	proUntil := time.Now().UTC().Add(30 * 24 * time.Hour)
	if _, _, err := svc.ApplyRCSubscriberState(ctx, "ev-timed", subscription.Snapshot{
		AppUserID: appUserID, Tier: account.TierPro, TierExpiresAt: &proUntil, SnapshotAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("apply timed: %v", err)
	}
	if _, _, err := svc.ApplyRCSubscriberState(ctx, "ev-notime-2",
		subscription.Snapshot{AppUserID: appUserID, Tier: account.TierFree}); err != nil {
		t.Fatalf("apply untimed after timed: %v", err)
	}
	u, err := svc.Users.Get(ctx, user.UserID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u.Tier != account.TierPro {
		t.Fatalf("tier = %q, want pro (an untimed snapshot must not override a timed one)", u.Tier)
	}
}
