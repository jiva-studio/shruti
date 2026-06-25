// Package orders holds the billing order domain model: the plan/price map and
// the order state machine. The order row (see internal/store) is the single
// source of truth; this package only defines the vocabulary the store,
// handlers and reconcile worker share.
package orders

import "github.com/google/uuid"

// Order states. The happy path is created → verified → granted → fulfilled.
// expired/failed are terminal off-ramps. Every transition is re-drivable from
// the row by the reconcile worker, so a lost IPN or a downstream (auth) outage
// self-heals on the next tick instead of stranding a paid user.
const (
	StatusCreated   = "created"
	StatusVerified  = "verified"
	StatusGranted   = "granted"
	StatusFulfilled = "fulfilled"
	StatusExpired   = "expired"
	StatusFailed    = "failed"
)

const (
	PlanMonthly = "monthly"
	PlanYearly  = "yearly"
)

// priceCents maps a plan to its USD price in cents. monthly = $2.99,
// yearly = $29.99.
var priceCents = map[string]int{
	PlanMonthly: 299,
	PlanYearly:  2999,
}

// ValidPlan reports whether p is a plan we sell.
func ValidPlan(p string) bool {
	_, ok := priceCents[p]
	return ok
}

// PriceCents returns the price for a plan; the bool is false for unknown plans.
func PriceCents(plan string) (int, bool) {
	c, ok := priceCents[plan]
	return c, ok
}

// Order is one purchase attempt — the row in billing.orders.
type Order struct {
	ID                uuid.UUID
	UserID            uuid.UUID
	Plan              string
	AmountCents       int
	Currency          string
	PaymentoToken     string
	PaymentoPaymentID string
	Status            string
	Attempts          int
	LastError         string
}
