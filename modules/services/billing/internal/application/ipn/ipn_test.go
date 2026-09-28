package ipn

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

type paymentOrders struct {
	ports.Orders
	byPayment map[string]*order.Order
}

func (p paymentOrders) GetByPaymentID(_ context.Context, id string) (*order.Order, error) {
	if o, ok := p.byPayment[id]; ok {
		return o, nil
	}
	return nil, ports.ErrOrderNotFound
}

type recordingDriver struct {
	driven []uuid.UUID
	err    error
}

func (d *recordingDriver) Drive(_ context.Context, id uuid.UUID) error {
	d.driven = append(d.driven, id)
	return d.err
}

func TestHandle(t *testing.T) {
	orderID := uuid.New()
	orders := paymentOrders{byPayment: map[string]*order.Order{
		"paid":    {ID: orderID, Status: order.StatusFulfilled},
		"pending": {ID: orderID, Status: order.StatusVerified},
	}}
	cases := []struct {
		name   string
		n      Notification
		driver *recordingDriver
		want   Outcome
		drives int
	}{
		{name: "fulfilled payment is a duplicate", n: Notification{PaymentID: "paid", OrderID: orderID.String(), OrderStatus: 8}, want: Duplicate},
		{name: "duplicate wins over an unusable order id", n: Notification{PaymentID: "paid", OrderID: "junk", OrderStatus: 8}, want: Duplicate},
		{name: "unfulfilled payment is driven", n: Notification{PaymentID: "pending", OrderID: orderID.String(), OrderStatus: 8}, want: Accepted, drives: 1},
		{name: "unknown payment is driven", n: Notification{PaymentID: "new", OrderID: orderID.String(), OrderStatus: 7}, want: Accepted, drives: 1},
		{name: "bad order id is unusable", n: Notification{OrderID: "not-a-uuid", OrderStatus: 8}, want: Unusable},
		{name: "timeout is not driven", n: Notification{OrderID: orderID.String(), OrderStatus: statusTimeout}, want: Accepted},
		{name: "cancel is not driven", n: Notification{OrderID: orderID.String(), OrderStatus: statusUserCanceled}, want: Accepted},
		{name: "reject is not driven", n: Notification{OrderID: orderID.String(), OrderStatus: statusReject}, want: Accepted},
		{name: "drive failure is still accepted", n: Notification{OrderID: orderID.String(), OrderStatus: 8}, driver: &recordingDriver{err: errors.New("auth down")}, want: Accepted, drives: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.driver
			if d == nil {
				d = &recordingDriver{}
			}
			s := &Service{Orders: orders, Driver: d}
			if got := s.Handle(t.Context(), tc.n); got != tc.want {
				t.Fatalf("outcome = %v, want %v", got, tc.want)
			}
			if len(d.driven) != tc.drives {
				t.Fatalf("drives = %d, want %d", len(d.driven), tc.drives)
			}
		})
	}
}
