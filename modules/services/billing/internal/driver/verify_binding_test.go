package driver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/orders"
	"github.com/jiva-studio/shruti/billing/internal/paymento"
	"github.com/jiva-studio/shruti/billing/internal/store"
)

// fakePaymentoBody serves /v1/payment/verify with body built for the order.
func fakePaymentoBody(t *testing.T, body func() string) *paymento.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write([]byte(body())); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return paymento.New(srv.URL, "test-key")
}

// verifyBody renders Paymento's documented verify response
// ({success, message, body: {token, orderId, orderStatus, additionalData}}).
func verifyBody(orderID, userID, plan string) string {
	return `{"success":true,"message":null,"body":{"token":"t","orderId":"` + orderID +
		`","orderStatus":8,"additionalData":[{"key":"userId","value":"` + userID +
		`"},{"key":"plan","value":"` + plan + `"}]}}`
}

// TestDriveGrantsOnlyForTheVerifiedOrder: an approved verify whose orderId,
// userId or plan names a different order is not this order's payment, so
// no grant is made and the order stays created.
func TestDriveGrantsOnlyForTheVerifiedOrder(t *testing.T) {
	cases := []struct {
		name  string
		body  func(o *orders.Order) string
		grant bool
	}{
		{"matching order", func(o *orders.Order) string {
			return verifyBody(o.ID.String(), o.UserID.String(), o.Plan)
		}, true},
		{"orderId upper-case", func(o *orders.Order) string {
			return verifyBody(strings.ToUpper(o.ID.String()), o.UserID.String(), o.Plan)
		}, true},
		{"other orderId", func(o *orders.Order) string {
			return verifyBody(uuid.NewString(), o.UserID.String(), o.Plan)
		}, false},
		{"other userId", func(o *orders.Order) string {
			return verifyBody(o.ID.String(), uuid.NewString(), o.Plan)
		}, false},
		{"other plan", func(o *orders.Order) string {
			return verifyBody(o.ID.String(), o.UserID.String(), orders.PlanYearly)
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			repo := &store.Repo{Pool: pool}
			auth, calls := fakeAuth(t, http.StatusOK)
			o := newOrder(t, repo)
			d := &Driver{Pool: pool, Repo: repo, Paymento: fakePaymentoBody(t, func() string { return tc.body(o) }), Auth: auth}

			err := d.Drive(t.Context(), o.ID)
			got, gerr := repo.GetByID(t.Context(), o.ID)
			if gerr != nil {
				t.Fatalf("get: %v", gerr)
			}
			if tc.grant {
				if err != nil || got.Status != orders.StatusFulfilled || atomic.LoadInt32(calls) != 1 {
					t.Fatalf("want fulfilled with one grant: err=%v status=%q grants=%d", err, got.Status, atomic.LoadInt32(calls))
				}
				return
			}
			if err == nil {
				t.Fatal("mismatched verify must return an error")
			}
			if got.Status != orders.StatusCreated || atomic.LoadInt32(calls) != 0 {
				t.Fatalf("want created with no grant: status=%q grants=%d", got.Status, atomic.LoadInt32(calls))
			}
			if got.Attempts != 1 || !strings.Contains(got.LastError, "mismatch") {
				t.Fatalf("attempt not recorded: attempts=%d last_error=%q", got.Attempts, got.LastError)
			}
		})
	}
}
