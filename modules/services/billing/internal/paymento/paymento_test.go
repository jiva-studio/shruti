package paymento

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestVerifyParsesDocumentedBody: the documented verify response nests
// orderId, a numeric orderStatus and additionalData under `body`.
func TestVerifyParsesDocumentedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := w.Write([]byte(`{"success":true,"message":null,"body":{"token":"t","orderId":"o-1","orderStatus":8,` +
			`"additionalData":[{"key":"userId","value":"u-1"},{"key":"plan","value":"monthly"}]}}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)

	res, err := New(srv.URL, "k").Verify(t.Context(), "t")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !res.Approved || res.OrderStatus != "8" {
		t.Errorf("approved=%v status=%q, want true/8", res.Approved, res.OrderStatus)
	}
	if res.OrderID != "o-1" {
		t.Errorf("orderId = %q, want o-1", res.OrderID)
	}
	if res.AdditionalData["userId"] != "u-1" || res.AdditionalData["plan"] != "monthly" {
		t.Errorf("additionalData = %v", res.AdditionalData)
	}
}

func TestVerifyWithoutEchoFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := w.Write([]byte(`{"orderStatus":"8","paymentId":"p"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)

	res, err := New(srv.URL, "k").Verify(t.Context(), "t")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.OrderID != "" || res.AdditionalData != nil {
		t.Errorf("absent fields: orderId=%q additionalData=%v, want empty", res.OrderID, res.AdditionalData)
	}
}
