// Package ports declares what billing's use cases ask of the outside world:
// the order store and its transactions, the payment gateway, and the auth
// service that grants the subscription.
package ports

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
)

// ErrOrderNotFound is returned when no stored order matches.
var ErrOrderNotFound = errors.New("order not found")

// ErrGatewayUnconfigured is returned by a PaymentGateway that has no API key.
var ErrGatewayUnconfigured = errors.New("API key not configured")

// Orders is the order collection and the queries the reconcile loop runs
// over it. Each call is its own statement; a transition that must not race
// goes through Transactor.
type Orders interface {
	// Create stores a new order in status created and returns it.
	Create(ctx context.Context, userID uuid.UUID, plan string, amountCents int) (*order.Order, error)
	Get(ctx context.Context, id uuid.UUID) (*order.Order, error)
	GetByPaymentID(ctx context.Context, paymentID string) (*order.Order, error)
	// SetToken records the gateway token a checkout redirects to.
	SetToken(ctx context.Context, id uuid.UUID, token string) error
	// BumpAttempt counts a failed step and records its error, leaving the
	// status for the next re-drive.
	BumpAttempt(ctx context.Context, id uuid.UUID, errMsg string) error
	// ListStuck returns up to limit orders still mid-flight (created, verified
	// or granted) untouched for longer than olderThan, oldest first.
	ListStuck(ctx context.Context, olderThan time.Duration, limit int) ([]*order.Order, error)
	// ExpireStale expires created orders older than olderThan and returns how
	// many it expired.
	ExpireStale(ctx context.Context, olderThan time.Duration) (int64, error)
}

// Transactor runs fn in one transaction, committed when fn returns nil.
type Transactor interface {
	WithinTx(ctx context.Context, fn func(tx OrderTx) error) error
}

// OrderTx is the order store inside a transaction. LockForUpdate holds the
// order's row until the transaction ends, so a webhook and the reconcile loop
// driving the same order serialize.
type OrderTx interface {
	LockForUpdate(ctx context.Context, id uuid.UUID) (*order.Order, error)
	// MarkVerified moves the order to verified and records the gateway's
	// payment id, which is unique across orders.
	MarkVerified(ctx context.Context, id uuid.UUID, paymentID string) error
	MarkGranted(ctx context.Context, id uuid.UUID) error
	MarkFulfilled(ctx context.Context, id uuid.UUID) error
}

// PaymentGateway starts payments and verifies them.
type PaymentGateway interface {
	Configured() bool
	// CreatePayment requests a payment for orderID and returns the token the
	// customer is redirected with.
	CreatePayment(ctx context.Context, fiatAmount, fiatCurrency, returnURL, orderID string, additional map[string]string) (token string, err error)
	// RedirectURL is where the customer pays for token.
	RedirectURL(token string) string
	Verify(ctx context.Context, token string) (*order.Verification, error)
}

// SubscriptionGranter grants the subscription a paid order bought. grantKey
// makes the grant idempotent: granting the same key twice extends nothing.
type SubscriptionGranter interface {
	Grant(ctx context.Context, userID, duration, grantKey string) error
}
