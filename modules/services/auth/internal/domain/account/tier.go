package account

import "time"

// Subscription tiers. The column is TEXT so another tier needs no schema
// change.
const (
	TierFree = "free"
	TierPro  = "pro"
)

// expiryGrace is the clock skew tolerated between this service, the database
// and RevenueCat when deciding whether an entitlement is still active. It is
// far shorter than any subscription period, so it only smooths the boundary.
const expiryGrace = 60 * time.Second

// StillActive reports whether an entitlement expiring at exp still counts as
// active at now.
func StillActive(exp, now time.Time) bool {
	return exp.After(now.Add(-expiryGrace))
}

// EffectiveTier is the tier a user holds at now: a "pro" whose expiry has
// passed reads as free, while the stored row waits for the next webhook or
// reconcile pass to correct it. An empty tier is free; a nil expiry never
// lapses.
func EffectiveTier(tier string, expiresAt *time.Time, now time.Time) string {
	if tier == "" {
		return TierFree
	}
	if tier == TierPro && expiresAt != nil && !StillActive(*expiresAt, now) {
		return TierFree
	}
	return tier
}
