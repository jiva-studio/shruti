package application_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

// A 404 refetch carries no RC time, a 200 refetch RC's request_date_ms.
// With the local clock ahead of RC's, a purchase fetched after the 404 must
// still be applied: the 404 is never stamped with the local clock.
func TestPurchaseAfterLocal404AppliesDespiteClockSkew(t *testing.T) {
	svc := bootSubscription(t)
	ctx := t.Context()
	user, err := svc.Anonymous(ctx, "dev-skew", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	const appUserID = "rc-app-user-skew"
	bindRCAppUserID(t, svc, user.UserID.String(), appUserID)
	seedWebhookEvent(t, svc, "ev-404", appUserID)
	seedWebhookEvent(t, svc, "ev-buy", appUserID)

	rcNow := time.Now().UTC().Truncate(time.Millisecond)
	localNow := rcNow.Add(2 * time.Second) // local clock 2s ahead of RC

	notFound := rcsync.SnapshotFromRCResponse(appUserID, &subscription.Customer{}, localNow)
	if _, _, err := svc.ApplyRCSubscriberState(ctx, "ev-404", notFound); err != nil {
		t.Fatalf("apply 404: %v", err)
	}
	future := rcNow.Add(30 * 24 * time.Hour)
	body := &subscription.Customer{
		RequestDateMs: rcNow.Add(time.Second).UnixMilli(), // one real second later
		Subscriber: &subscription.Subscriber{
			OriginalAppUserID: appUserID,
			Entitlements: map[string]subscription.Entitlement{
				"pro": {ExpiresDate: &future},
			},
		},
	}
	bought := rcsync.SnapshotFromRCResponse(appUserID, body, localNow.Add(time.Second))
	if bought.Tier != account.TierPro {
		t.Fatalf("fixture: snapshot tier %q, want pro", bought.Tier)
	}
	if _, _, err := svc.ApplyRCSubscriberState(ctx, "ev-buy", bought); err != nil {
		t.Fatalf("apply purchase: %v", err)
	}
	u, err := svc.Users.Get(ctx, user.UserID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if u.Tier != account.TierPro {
		t.Fatalf("tier = %q, want pro: the purchase was refused as older than a 404 stamped on another clock", u.Tier)
	}
}
