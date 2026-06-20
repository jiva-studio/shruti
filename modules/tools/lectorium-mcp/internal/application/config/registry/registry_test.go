package configregistry

import (
	"context"
	"strings"
	"testing"
)

func newTestRegistry(known map[string]bool) *Registry {
	r := New(ValidateDeps{
		TopicExists: func(_ context.Context, id string) (bool, error) {
			return known[id], nil
		},
	})
	r.Register(OnboardingTopicsDescriptor())
	return r
}

func TestOnboardingTopics_Valid(t *testing.T) {
	r := newTestRegistry(map[string]bool{"topic_a": true, "topic_b": true})
	if err := r.Validate(context.Background(), "onboarding.topics", []byte(`["topic_a","topic_b"]`)); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
}

func TestOnboardingTopics_Rejects(t *testing.T) {
	r := newTestRegistry(map[string]bool{"topic_a": true})
	cases := []struct {
		name, value, wantSubstr string
	}{
		{"empty array", `[]`, "empty"},
		{"not array", `"topic_a"`, "JSON array"},
		{"bad prefix", `["foo"]`, "must start"},
		{"duplicate", `["topic_a","topic_a"]`, "duplicate"},
		{"unknown id", `["topic_a","topic_x"]`, "unknown topic"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := r.Validate(context.Background(), "onboarding.topics", []byte(c.value))
			if err == nil {
				t.Fatalf("expected error for %s", c.value)
			}
			if !strings.Contains(err.Error(), c.wantSubstr) {
				t.Fatalf("error %q missing %q", err.Error(), c.wantSubstr)
			}
		})
	}
}

func TestUnknownKey(t *testing.T) {
	r := newTestRegistry(nil)
	if err := r.Validate(context.Background(), "nope.key", []byte(`[]`)); err == nil {
		t.Fatal("expected error for unknown key")
	}
	if _, ok := r.Get("nope.key"); ok {
		t.Fatal("unexpected descriptor")
	}
	if got := r.Keys(); len(got) != 1 || got[0] != "onboarding.topics" {
		t.Fatalf("unexpected keys %v", got)
	}
}
