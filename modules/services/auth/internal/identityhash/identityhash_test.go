package identityhash

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/store"
)

func id(provider, subject string, createdAt time.Time) store.Identity {
	return store.Identity{
		Provider:  provider,
		Subject:   subject,
		CreatedAt: createdAt,
	}
}

// sha256Hex is the same computation Compute does internally — duplicated
// in the test so an unintentional change to the algorithm fails the
// assertion instead of silently agreeing with itself.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestCompute_Empty(t *testing.T) {
	if got := Compute(nil); got != "" {
		t.Errorf("nil identities: got %q, want \"\"", got)
	}
	if got := Compute([]store.Identity{}); got != "" {
		t.Errorf("empty slice: got %q, want \"\"", got)
	}
}

func TestCompute_DeviceOnly_ReturnsNonEmpty(t *testing.T) {
	// Anonymous (device-only) users get a stable peppered hash so the
	// chat-side rate limiter keys their counter on a per-device value
	// instead of falling back to `sub`. Without this, uninstall +
	// reinstall would reset the anon counter and effectively void the
	// 3/day cap. Earliest device identity wins for stability — same as
	// the OAuth path.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := Compute([]store.Identity{
		id("device", "device-A", base),
		id("device", "device-B", base.Add(time.Hour)),
	})
	if got == "" {
		t.Fatal("device-only: got empty hash, want non-empty")
	}
	if len(got) != 64 {
		t.Errorf("device-only: hash length %d, want 64", len(got))
	}
	// Earliest wins: same input again must yield same hash.
	again := Compute([]store.Identity{
		id("device", "device-A", base),
		id("device", "device-B", base.Add(time.Hour)),
	})
	if again != got {
		t.Errorf("device-only: non-deterministic, %q vs %q", got, again)
	}
	// Different device subject → different hash.
	other := Compute([]store.Identity{id("device", "device-Z", base)})
	if other == got {
		t.Error("different device subjects must produce different hashes")
	}
}

func TestCompute_DeviceOnly_StableAcrossReinstall(t *testing.T) {
	// The whole point of the device-only path: uninstall + reinstall
	// keeps the same OS-stable device id, so the quota_id must match
	// across the gap. Models that gap by giving the "after" identity a
	// fresh CreatedAt but the same subject.
	before := []store.Identity{
		id("device", "stable-device-subject", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	after := []store.Identity{
		id("device", "stable-device-subject", time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)),
	}
	if h1, h2 := Compute(before), Compute(after); h1 != h2 {
		t.Errorf("anon reinstall broke the hash: %q vs %q", h1, h2)
	}
}

func TestCompute_NonDeviceWinsOverDevice(t *testing.T) {
	// When the user has both an OAuth identity AND a device identity
	// (post-upgrade: anon device row plus a Google sign-in), the OAuth
	// hash wins — same as before PR-1. Device-only is the fallback,
	// not the primary path.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	withBoth := Compute([]store.Identity{
		id("device", "dev-1", base),
		id("google", "gsub-1", base.Add(time.Hour)),
	})
	oauthOnly := Compute([]store.Identity{
		id("google", "gsub-1", base.Add(time.Hour)),
	})
	if withBoth != oauthOnly {
		t.Errorf("device identity changed the hash: with-both=%q oauth-only=%q", withBoth, oauthOnly)
	}
}

func TestCompute_SingleNonDeviceIdentity(t *testing.T) {
	got := Compute([]store.Identity{
		id("apple", "001234.abcdef.5678", time.Now()),
	})
	want := sha256Hex("apple:001234.abcdef.5678")
	if got != want {
		t.Errorf("single apple: got %q, want %q", got, want)
	}
}

func TestCompute_DeviceIgnoredAmongstReal(t *testing.T) {
	// Mixed identity set: device should never win, even if it has the
	// earliest CreatedAt. The chat counter must follow the OAuth
	// identity, not the (transient, install-scoped) device id.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := Compute([]store.Identity{
		id("device", "device-id", base),               // earliest
		id("google", "gsub-1", base.Add(1*time.Hour)), // wins
		id("apple", "asub-1", base.Add(24*time.Hour)),
	})
	want := sha256Hex("google:gsub-1")
	if got != want {
		t.Errorf("mixed: got %q, want %q", got, want)
	}
}

func TestCompute_EarliestNonDeviceWins(t *testing.T) {
	// Two OAuth identities → earliest by CreatedAt is the quota anchor.
	// Adding a second provider later must not reset the quota counter.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := Compute([]store.Identity{
		id("google", "first-google-sub", base),
		id("apple", "later-apple-sub", base.Add(48*time.Hour)),
	})
	want := sha256Hex("google:first-google-sub")
	if got != want {
		t.Errorf("earliest: got %q, want %q", got, want)
	}
}

func TestCompute_OrderIndependent(t *testing.T) {
	// ListForUser returns oldest-first, but we shouldn't rely on slice
	// order. Same set of identities → same hash regardless of order.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	a := id("google", "g-sub", base)
	b := id("apple", "a-sub", base.Add(time.Hour))
	got1 := Compute([]store.Identity{a, b})
	got2 := Compute([]store.Identity{b, a})
	if got1 != got2 {
		t.Errorf("order matters: %q vs %q", got1, got2)
	}
}

func TestCompute_DeleteRecreateScenario(t *testing.T) {
	// The actual abuse vector this guards against: a user signs in with
	// Apple, deletes the account, signs back in with the SAME Apple
	// subject — gets a fresh auth.users.id but Compute() must return
	// the SAME quota_id so the day's chat counter persists.
	before := []store.Identity{
		id("apple", "stable-apple-subject", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	// After delete+recreate the row has a NEW CreatedAt (Postgres sets
	// it again on INSERT) — what stays the same is the provider+subject.
	after := []store.Identity{
		id("apple", "stable-apple-subject", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)),
	}
	if h1, h2 := Compute(before), Compute(after); h1 != h2 {
		t.Errorf("delete+recreate broke the hash: %q vs %q", h1, h2)
	}
}

func TestCompute_DifferentProvidersDiffer(t *testing.T) {
	// Same subject string under different providers is a different
	// person. sha256 input concatenates provider + ":" + subject for
	// exactly this reason.
	a := Compute([]store.Identity{
		id("google", "shared-sub-string", time.Now()),
	})
	b := Compute([]store.Identity{
		id("apple", "shared-sub-string", time.Now()),
	})
	if a == b {
		t.Errorf("provider doesn't affect hash: both = %q", a)
	}
}
