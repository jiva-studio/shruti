package bunny

import (
	"bytes"
	"context"
	"os"
	"testing"
)

// TestLiveRoundTrip exercises the real Bunny Storage HTTP API. It is skipped
// unless BUNNY_TEST_ZONE and BUNNY_TEST_KEY are set, so it never runs in CI.
func TestLiveRoundTrip(t *testing.T) {
	zone := os.Getenv("BUNNY_TEST_ZONE")
	key := os.Getenv("BUNNY_TEST_KEY")
	if zone == "" || key == "" {
		t.Skip("set BUNNY_TEST_ZONE and BUNNY_TEST_KEY for the live test")
	}
	u, err := New(Target{Zone: zone, AccessKey: key})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	obj := `{"hello":"bunny","n":42}`
	k := "migtest/roundtrip.json"

	if err := u.Put(ctx, k, "application/json", bytes.NewReader([]byte(obj)), int64(len(obj))); err != nil {
		t.Fatalf("put: %v", err)
	}

	size, etag, exists, err := u.Head(ctx, k)
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if !exists {
		t.Fatal("head: object missing right after put")
	}
	if size != int64(len(obj)) {
		t.Fatalf("head size=%d want %d", size, len(obj))
	}
	t.Logf("head ok: size=%d checksum=%s", size, etag)

	var out struct {
		Hello string `json:"hello"`
		N     int    `json:"n"`
	}
	found, err := u.GetJSON(ctx, k, &out)
	if err != nil {
		t.Fatalf("getjson: %v", err)
	}
	if !found || out.Hello != "bunny" || out.N != 42 {
		t.Fatalf("getjson mismatch: %+v found=%v", out, found)
	}

	_, _, exists, err = u.Head(ctx, "migtest/does-not-exist-xyz.json")
	if err != nil {
		t.Fatalf("head missing: %v", err)
	}
	if exists {
		t.Fatal("head: false positive on a missing key")
	}
}
