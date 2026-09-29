package paymento

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func verifyBody(t *testing.T, body string) *VerifyResult {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	res, err := New(srv.URL, "k").Verify(t.Context(), "t")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	return res
}

// TestVerifyReadsTopLevelEchoFields: the flat response shape carries the
// echo fields beside orderStatus, and the top level wins over `body`.
func TestVerifyReadsTopLevelEchoFields(t *testing.T) {
	res := verifyBody(t, `{"orderStatus":"8","orderId":"o-top",`+
		`"additionalData":[{"key":"userId","value":"u-top"}],`+
		`"body":{"orderId":"o-body","additionalData":[{"key":"userId","value":"u-body"}]}}`)
	if res.OrderID != "o-top" {
		t.Errorf("orderId = %q, want o-top", res.OrderID)
	}
	if res.AdditionalData["userId"] != "u-top" {
		t.Errorf("userId = %q, want u-top", res.AdditionalData["userId"])
	}
}

// TestVerifyToleratesMalformedAdditionalData: entries that are not
// {key, value} string pairs are skipped or read as "", never a panic, and a
// non-string value for a bound key reads as "" so the driver refuses it.
func TestVerifyToleratesMalformedAdditionalData(t *testing.T) {
	res := verifyBody(t, `{"orderStatus":8,"additionalData":[`+
		`"junk", 7, null, {"value":"no-key"}, {"key":""}, {"key":5,"value":"x"},`+
		`{"key":"plan","value":12}, {"key":"userId","value":"u-1"}]}`)
	if !res.Approved {
		t.Fatalf("status 8 must approve")
	}
	if len(res.AdditionalData) != 2 {
		t.Fatalf("additionalData = %v, want only plan and userId", res.AdditionalData)
	}
	if v, ok := res.AdditionalData["plan"]; !ok || v != "" {
		t.Errorf("non-string plan = %q (present=%v), want present and empty", v, ok)
	}
	if res.AdditionalData["userId"] != "u-1" {
		t.Errorf("userId = %q, want u-1", res.AdditionalData["userId"])
	}
}
