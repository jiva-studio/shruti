package handler

import (
	"net/http/httptest"
	"testing"
)

// TestBearerCheck covers the matrix:
//   - valid primary secret  → accepted
//   - valid secondary secret → accepted (during a rotation)
//   - mismatching token     → rejected
//   - missing Authorization → rejected
//   - empty slots           → rejected even on empty Bearer (defence
//     against an unset rotation slot matching a header like "Bearer ").
func TestBearerCheck(t *testing.T) {
	h := &RCWebhookHandler{
		SecretPrimary:   "primary-secret-value",
		SecretSecondary: "secondary-secret-value",
	}

	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"primary accepted", "Bearer primary-secret-value", true},
		{"secondary accepted", "Bearer secondary-secret-value", true},
		{"wrong secret rejected", "Bearer not-the-secret", false},
		{"missing header rejected", "", false},
		{"non-bearer scheme rejected", "Basic primary-secret-value", false},
		{"empty bearer value rejected", "Bearer ", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			if got := h.checkBearer(r); got != tc.want {
				t.Fatalf("checkBearer(%q) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}

// TestBearerCheckSecondaryOnly verifies that primary can be unset during
// the final phase of rotation (operator cleared the old key and only the
// new secondary is live).
func TestBearerCheckSecondaryOnly(t *testing.T) {
	h := &RCWebhookHandler{SecretSecondary: "new-only"}
	r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
	r.Header.Set("Authorization", "Bearer new-only")
	if !h.checkBearer(r) {
		t.Fatal("secondary-only setup must accept its own secret")
	}
}

// TestBearerCheckBothEmpty — defensive: if the operator boots with both
// slots empty (misconfiguration) we must never accept any request.
// main.go also guards this at boot, this is belt-and-suspenders for the
// handler in isolation.
func TestBearerCheckBothEmpty(t *testing.T) {
	h := &RCWebhookHandler{}
	r := httptest.NewRequest("POST", "/webhooks/revenuecat", nil)
	r.Header.Set("Authorization", "Bearer anything")
	if h.checkBearer(r) {
		t.Fatal("empty secrets must reject every request")
	}
	// And specifically reject "Bearer " (empty token) so an unset slot
	// can't be coerced by an empty-token attack.
	r.Header.Set("Authorization", "Bearer ")
	if h.checkBearer(r) {
		t.Fatal("empty secrets must reject an empty-token bearer too")
	}
}
