// Package ipn acts on a Paymento instant payment notification. The
// notification is only a nudge: the order is driven, and driving re-verifies
// the payment with the gateway before anything is granted.
package ipn

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

// Paymento's numeric OrderStatus codes that say the payment will not
// complete.
const (
	statusTimeout      = 4
	statusUserCanceled = 5
	statusReject       = 9
)

// Notification is what an IPN says about a payment.
type Notification struct {
	PaymentID   string
	OrderID     string
	OrderStatus int
}

// Outcome is how a notification was taken.
type Outcome int

const (
	// Accepted: the notification was acted on, or deliberately left for the
	// reconcile loop.
	Accepted Outcome = iota
	// Duplicate: the payment it names already fulfilled its order.
	Duplicate
	// Unusable: it names no order.
	Unusable
)

// Driver advances one order as far as it can go.
type Driver interface {
	Drive(ctx context.Context, orderID uuid.UUID) error
}

// Service handles notifications.
type Service struct {
	Orders ports.Orders
	Driver Driver
}

// Handle acts on n. A drive that fails is logged, not returned: the order
// stays where it is for the reconcile loop, and the gateway is not asked to
// deliver again.
func (s *Service) Handle(ctx context.Context, n Notification) Outcome {
	if n.PaymentID != "" {
		if o, err := s.Orders.GetByPaymentID(ctx, n.PaymentID); err == nil && o.Status == order.StatusFulfilled {
			return Duplicate
		}
	}

	orderID, err := uuid.Parse(n.OrderID)
	if err != nil {
		slog.WarnContext(ctx, "billing_webhook_bad_order_id", "order_id", n.OrderID)
		return Unusable
	}

	slog.InfoContext(ctx, "billing_webhook_received",
		"order_id", n.OrderID, "ipn_status", n.OrderStatus, "payment_id", n.PaymentID)

	switch n.OrderStatus {
	case statusTimeout, statusUserCanceled, statusReject:
		slog.InfoContext(ctx, "billing_webhook_negative_status",
			"order_id", n.OrderID, "ipn_status", n.OrderStatus)
	default:
		if err := s.Driver.Drive(ctx, orderID); err != nil {
			slog.WarnContext(ctx, "billing_webhook_drive_failed",
				"order_id", n.OrderID, "err", err.Error())
		}
	}
	return Accepted
}
