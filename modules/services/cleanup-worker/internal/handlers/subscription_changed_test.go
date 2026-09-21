package handlers

import (
	"encoding/json"
	"testing"
)

func TestSubscriptionChanged_ParsesPayload(t *testing.T) {
	h := SubscriptionChanged()
	payload, _ := json.Marshal(map[string]any{
		"tier":            "pro",
		"tier_expires_at": "2026-06-25T00:00:00Z",
		"rc_app_user_id":  "user_42",
	})
	err := h(t.Context(), Event{
		ID:          7,
		EventType:   "subscription.changed",
		AggregateID: "11111111-2222-3333-4444-555555555555",
		Payload:     payload,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSubscriptionChanged_TolesMalformedPayload(t *testing.T) {
	// A schema mismatch must not fail the event — the row should still
	// get marked processed by the worker.
	h := SubscriptionChanged()
	err := h(t.Context(), Event{
		AggregateID: "abc",
		Payload:     []byte("not json"),
	})
	if err != nil {
		t.Fatalf("expected nil on bad payload, got %v", err)
	}
}
