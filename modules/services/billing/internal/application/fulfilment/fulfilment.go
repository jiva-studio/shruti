// Package fulfilment advances a paid order to fulfilled: verify the payment
// with the gateway, grant the subscription, record each step.
package fulfilment

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

// Service advances an order through created → verified → granted → fulfilled.
// Both the IPN webhook and the reconcile loop call Drive; the stored order is
// the source of truth and every step is idempotent and re-drivable, so a lost
// IPN or a transient auth/Paymento outage self-heals on the next tick.
//
//   - verify-before-grant: PRO is never granted off the IPN alone. The order
//     only leaves `created` or `expired` after the gateway's verify approves it.
//   - row locking: each transition runs in one transaction holding the order's
//     row, so a concurrent webhook and reconcile can't double-advance it, and
//     the unique payment id makes a duplicate IPN a no-op.
//   - a failure leaves the order in place with its attempt recorded, for the
//     next re-drive, rather than dropping the payment.
type Service struct {
	Orders  ports.Orders
	Tx      ports.Transactor
	Gateway ports.PaymentGateway
	Granter ports.SubscriptionGranter
}

// Drive moves the order one or more steps toward fulfilled, as far as the
// current external state allows. It is safe to call repeatedly.
func (s *Service) Drive(ctx context.Context, orderID uuid.UUID) error {
	o, err := s.Orders.Get(ctx, orderID)
	if err != nil {
		return err
	}
	if o.IsSettled() {
		return nil
	}

	// Verify runs outside the row lock: it is a network call, and the lock is
	// not held across one.
	if o.AwaitsVerification() {
		if err := s.verify(ctx, o); err != nil {
			return err
		}
		o, err = s.Orders.Get(ctx, orderID)
		if err != nil {
			return err
		}
	}

	if o.Status == order.StatusVerified || o.Status == order.StatusGranted {
		if err := s.grantAndFulfill(ctx, o); err != nil {
			return err
		}
	}
	return nil
}

// verify asks the gateway about the order's payment and, on approval, moves
// the order created/expired → verified, recording the payment id. The decision
// is re-made on the locked row, which may have expired during the gateway call.
func (s *Service) verify(ctx context.Context, o *order.Order) error {
	if o.PaymentoToken == "" {
		return fmt.Errorf("order %s has no paymento token", o.ID)
	}
	res, err := s.Gateway.Verify(ctx, o.PaymentoToken)
	if err != nil {
		s.bumpAttempt(ctx, o.ID, "verify: "+err.Error())
		return err
	}
	if !res.Approved {
		s.bumpAttempt(ctx, o.ID, "verify: not approved (status="+res.OrderStatus+")")
		slog.InfoContext(ctx, "billing_verify_not_approved",
			"order_id", o.ID.String(), "order_status", res.OrderStatus)
		return nil
	}
	if err := o.CheckVerification(res); err != nil {
		s.bumpAttempt(ctx, o.ID, "verify: "+err.Error())
		slog.ErrorContext(ctx, "billing_verify_order_mismatch",
			"order_id", o.ID.String(), "err", err.Error())
		return err
	}
	return s.Tx.WithinTx(ctx, func(tx ports.OrderTx) error {
		locked, err := tx.LockForUpdate(ctx, o.ID)
		if err != nil {
			return err
		}
		if !locked.AwaitsVerification() {
			return nil // a concurrent drive already advanced it
		}
		if locked.Status == order.StatusExpired {
			slog.WarnContext(ctx, "billing_verify_expired_order_honoured",
				"order_id", o.ID.String(), "payment_id", res.PaymentID)
		}
		return tx.MarkVerified(ctx, o.ID, res.PaymentID)
	})
}

// bumpAttempt records a failed step on the order. The step's own outcome is
// already decided, so a failure to record it is logged.
func (s *Service) bumpAttempt(ctx context.Context, id uuid.UUID, msg string) {
	if err := s.Orders.BumpAttempt(ctx, id, msg); err != nil {
		slog.ErrorContext(ctx, "billing_bump_attempt_failed",
			"order_id", id.String(), "err", err.Error())
	}
}

// grantAndFulfill grants the subscription and, on success, moves the order
// verified/granted → fulfilled. A grant failure leaves the order at verified
// for the reconcile loop.
func (s *Service) grantAndFulfill(ctx context.Context, o *order.Order) error {
	if err := s.Granter.Grant(ctx, o.UserID.String(), o.Plan, o.ID.String()); err != nil {
		s.bumpAttempt(ctx, o.ID, "grant: "+err.Error())
		return err
	}
	return s.Tx.WithinTx(ctx, func(tx ports.OrderTx) error {
		locked, err := tx.LockForUpdate(ctx, o.ID)
		if err != nil {
			return err
		}
		switch locked.Status {
		case order.StatusFulfilled:
			return nil
		case order.StatusVerified, order.StatusGranted:
			if err := tx.MarkGranted(ctx, o.ID); err != nil {
				return err
			}
			return tx.MarkFulfilled(ctx, o.ID)
		default:
			return nil
		}
	})
}
