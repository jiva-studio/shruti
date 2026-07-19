package ingest

import "testing"

// The track_id must be a pure function of the audio bytes: same bytes -> same
// id (idempotent re-ingest), and it must match a known SHA-256 vector so the id
// space is stable across builds/languages.
func TestContentID(t *testing.T) {
	// Deterministic: two calls on equal input agree.
	if a, b := ContentID([]byte("hare krishna")), ContentID([]byte("hare krishna")); a != b {
		t.Fatalf("ContentID not deterministic: %s != %s", a, b)
	}

	// Stable golden vector: SHA-256 of the empty input (nil == empty).
	const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := ContentID(nil); got != emptyDigest {
		t.Fatalf("ContentID(nil) = %s, want %s", got, emptyDigest)
	}

	// Distinct inputs must not collide.
	if ContentID([]byte("a")) == ContentID([]byte("b")) {
		t.Fatal("distinct inputs produced the same id")
	}
}
