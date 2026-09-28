package fulfilment

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

// staleOrders answers Get with a queue of statuses, so a test can make the
// unlocked read disagree with the row the transaction then locks.
type staleOrders struct {
	ports.Orders
	o        order.Order
	statuses []string
}

func (s *staleOrders) Get(_ context.Context, _ uuid.UUID) (*order.Order, error) {
	o := s.o
	if len(s.statuses) > 0 {
		o.Status, s.statuses = s.statuses[0], s.statuses[1:]
	}
	return &o, nil
}

func (s *staleOrders) BumpAttempt(context.Context, uuid.UUID, string) error { return nil }

// lockedTx reports a fixed status for the locked row and records transitions.
type lockedTx struct {
	status string
	marks  []string
}

func (l *lockedTx) WithinTx(ctx context.Context, fn func(ports.OrderTx) error) error {
	return fn(l)
}

func (l *lockedTx) LockForUpdate(_ context.Context, id uuid.UUID) (*order.Order, error) {
	return &order.Order{ID: id, Status: l.status}, nil
}

func (l *lockedTx) MarkVerified(context.Context, uuid.UUID, string) error {
	l.marks = append(l.marks, order.StatusVerified)
	return nil
}

func (l *lockedTx) MarkGranted(context.Context, uuid.UUID) error {
	l.marks = append(l.marks, order.StatusGranted)
	return nil
}

func (l *lockedTx) MarkFulfilled(context.Context, uuid.UUID) error {
	l.marks = append(l.marks, order.StatusFulfilled)
	return nil
}

type approvingGateway struct{ ports.PaymentGateway }

func (approvingGateway) Verify(context.Context, string) (*order.Verification, error) {
	return &order.Verification{Approved: true, OrderStatus: "8", PaymentID: "pay-1"}, nil
}

type countingGranter struct{ calls int }

func (g *countingGranter) Grant(context.Context, string, string, string) error {
	g.calls++
	return nil
}

// Given an order read as created outside the lock, when the locked row shows a
// concurrent drive already fulfilled it, then verify writes nothing: a
// fulfilled order is never walked back to verified.
func TestVerifyLeavesAnOrderAdvancedUnderTheLockAlone(t *testing.T) {
	id := uuid.New()
	orders := &staleOrders{
		o:        order.Order{ID: id, UserID: uuid.New(), Plan: order.PlanMonthly, PaymentoToken: "tok"},
		statuses: []string{order.StatusCreated, order.StatusFulfilled},
	}
	tx := &lockedTx{status: order.StatusFulfilled}
	granter := &countingGranter{}
	s := &Service{Orders: orders, Tx: tx, Gateway: approvingGateway{}, Granter: granter}

	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := s.Drive(ctx, id); err != nil {
		t.Fatalf("drive: %v", err)
	}
	if len(tx.marks) != 0 {
		t.Fatalf("transitions written over a fulfilled row: %v", tx.marks)
	}
	if granter.calls != 0 {
		t.Fatalf("granted %d times for an already fulfilled order", granter.calls)
	}
}
