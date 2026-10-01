// Package order is the billing order: the plans sold, their prices, the
// state machine an order moves through, and the rule that decides whether a
// verified payment belongs to an order.
package order

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Order states. The happy path is created → verified → granted → fulfilled.
// failed is a terminal off-ramp; expired marks an unpaid order past its window
// and yields to a payment the gateway approves. Every transition is re-drivable from
// the stored order, so a lost IPN or a downstream (auth) outage self-heals on
// the next reconcile tick instead of stranding a paid user.
const (
	StatusCreated   = "created"
	StatusVerified  = "verified"
	StatusGranted   = "granted"
	StatusFulfilled = "fulfilled"
	StatusExpired   = "expired"
	StatusFailed    = "failed"
)

// VerifyUnanswered starts the last error of an order whose payment the gateway
// was asked about and did not answer. The reconcile loop re-drives such an
// order even once it has expired, until the gateway answers.
const VerifyUnanswered = "verify unanswered: "

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

// PriceCents returns the price for a plan; the bool is false for unknown plans.
func PriceCents(plan string) (int, bool) {
	c, ok := priceCents[plan]
	return c, ok
}

// Order is one purchase attempt.
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

// IsSettled reports whether the order has reached a terminal state and has
// nothing left to drive.
func (o *Order) IsSettled() bool {
	switch o.Status {
	case StatusFulfilled, StatusFailed:
		return true
	}
	return false
}

// AwaitsVerification reports whether the order's payment is still to be
// verified with the gateway: a created order, or an expired one whose payment
// may have been approved after its window closed.
func (o *Order) AwaitsVerification() bool {
	return o.Status == StatusCreated || o.Status == StatusExpired
}

// Verification is the payment gateway's authoritative answer about a payment.
// Approved is true only for a fully confirmed payment. OrderID and
// AdditionalData echo what the checkout sent; "" / nil when the gateway omits
// them.
type Verification struct {
	Approved       bool
	OrderStatus    string
	PaymentID      string
	OrderID        string
	AdditionalData map[string]string
}

// CheckVerification reports whether an approved verification is this order's
// payment: the order id, and the userId / plan the checkout sent as
// additional data, each compared when the verification carries it.
func (o *Order) CheckVerification(v *Verification) error {
	if v.OrderID != "" && !strings.EqualFold(v.OrderID, o.ID.String()) {
		return fmt.Errorf("order mismatch: verify orderId %q", v.OrderID)
	}
	if uid, ok := v.AdditionalData["userId"]; ok && !strings.EqualFold(uid, o.UserID.String()) {
		return fmt.Errorf("order mismatch: verify userId %q", uid)
	}
	if plan, ok := v.AdditionalData["plan"]; ok && plan != o.Plan {
		return fmt.Errorf("order mismatch: verify plan %q", plan)
	}
	return nil
}
