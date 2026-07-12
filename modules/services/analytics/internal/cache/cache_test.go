package cache

import (
	"testing"
	"time"
)

func TestCacheHitMissAndExpiry(t *testing.T) {
	c := New()
	now := time.Unix(1_000_000, 0)
	c.now = func() time.Time { return now }

	if _, ok := c.Get("k"); ok {
		t.Fatal("expected miss on empty cache")
	}

	c.Set("k", Entry{Result: "v", GeneratedAt: 42}, 60*time.Second)
	e, ok := c.Get("k")
	if !ok || e.Result != "v" || e.GeneratedAt != 42 {
		t.Fatalf("expected hit with v/42, got ok=%v entry=%+v", ok, e)
	}

	// Advance past the TTL — entry must expire.
	now = now.Add(61 * time.Second)
	if _, ok := c.Get("k"); ok {
		t.Fatal("expected expiry after TTL elapsed")
	}
}

func TestCacheZeroTTLNotServed(t *testing.T) {
	c := New()
	now := time.Unix(1_000_000, 0)
	c.now = func() time.Time { return now }
	c.Set("k", Entry{Result: "v"}, 0)
	if _, ok := c.Get("k"); ok {
		t.Fatal("zero TTL entry should not be served")
	}
}
