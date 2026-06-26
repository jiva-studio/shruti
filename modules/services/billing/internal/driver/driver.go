// Package driver advances an order through the billing state machine. It sits
// above the pure domain (orders) + persistence (store) packages so it can call
// the external Paymento + auth clients without creating an import cycle.
package driver

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/shruti/billing/internal/authclient"
	"github.com/akdasa-studios/shruti/billing/internal/orders"
	"github.com/akdasa-studios/shruti/billing/internal/paymento"
	"github.com/akdasa-studios/shruti/billing/internal/store"
)

// Driver advances an order through created → verified → granted → fulfilled.
// Both the IPN webhook and the reconcile worker call Drive; the order row is
// the source of truth and every step is idempotent + re-drivable, so a lost
// IPN or a transient auth/Paymento outage self-heals on the next tick.
//
// Resilience contract:
//   - verify-before-grant: we NEVER grant PRO off the IPN alone. The order only
//     leaves `created` after Paymento /payment/verify returns Approve.
//   - row locking: each transition takes SELECT ... FOR UPDATE so a concurrent
//     webhook + reconcile can't double-advance (and the UNIQUE
//     paymento_payment_id makes a duplicate IPN a no-op).
//   - failures leave the order in place (attempts bumped) for the next re-drive
//     rather than dropping the payment.
type Driver struct {
	Pool     *pgxpool.Pool
	Repo     *store.Repo
	Paymento *paymento.Client
	Auth     *authclient.Client
}

// Drive moves the order one or more steps toward fulfilled, as far as the
// current external state allows. It is safe to call repeatedly.
func (d *Driver) Drive(ctx context.Context, orderID uuid.UUID) error {
	// Verify step runs first (outside the row lock) when still in `created`,
	// since it's a network call we don't want to hold a row lock across.
	o, err := d.Repo.GetByID(ctx, orderID)
	if err != nil {
		return err
	}

	switch o.Status {
	case orders.StatusFulfilled, orders.StatusExpired, orders.StatusFailed:
		return nil
	}

	if o.Status == orders.StatusCreated {
		if err := d.verify(ctx, o); err != nil {
			return err
		}
		// Re-read to pick up the new status set by verify.
		o, err = d.Repo.GetByID(ctx, orderID)
		if err != nil {
			return err
		}
	}

	if o.Status == orders.StatusVerified || o.Status == orders.StatusGranted {
		if err := d.grantAndFulfill(ctx, o); err != nil {
			return err
		}
	}
	return nil
}

// verify calls Paymento /payment/verify and, on Approve, locks the row and
// transitions created → verified (recording the payment id for idempotency).
func (d *Driver) verify(ctx context.Context, o *orders.Order) error {
	if o.PaymentoToken == "" {
		return fmt.Errorf("order %s has no paymento token", o.ID)
	}
	res, err := d.Paymento.Verify(ctx, o.PaymentoToken)
	if err != nil {
		_ = d.Repo.BumpAttempt(ctx, o.ID, "verify: "+err.Error())
		return err
	}
	if !res.Approved {
		// Not approved (pending/paid/etc) — leave at created for re-drive.
		_ = d.Repo.BumpAttempt(ctx, o.ID, "verify: not approved (status="+res.OrderStatus+")")
		slog.InfoContext(ctx, "billing_verify_not_approved",
			"order_id", o.ID.String(), "order_status", res.OrderStatus)
		return nil
	}
	return pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
		locked, err := d.Repo.LockForUpdate(ctx, tx, o.ID)
		if err != nil {
			return err
		}
		if locked.Status != orders.StatusCreated {
			return nil // a concurrent driver already advanced it
		}
		return store.MarkVerified(ctx, tx, o.ID, res.PaymentID)
	})
}

// grantAndFulfill calls the auth grant endpoint and, on success, locks the row
// and transitions verified/granted → fulfilled. A grant failure leaves the
// order at verified for the reconcile worker.
func (d *Driver) grantAndFulfill(ctx context.Context, o *orders.Order) error {
	if err := d.Auth.Grant(ctx, o.UserID.String(), o.Plan, o.ID.String()); err != nil {
		_ = d.Repo.BumpAttempt(ctx, o.ID, "grant: "+err.Error())
		return err
	}
	return pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
		locked, err := d.Repo.LockForUpdate(ctx, tx, o.ID)
		if err != nil {
			return err
		}
		switch locked.Status {
		case orders.StatusFulfilled:
			return nil
		case orders.StatusVerified, orders.StatusGranted:
			if err := store.MarkGranted(ctx, tx, o.ID); err != nil {
				return err
			}
			return store.MarkFulfilled(ctx, tx, o.ID)
		default:
			return nil
		}
	})
}
