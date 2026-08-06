package fetch

import (
	"testing"
	"time"
)

// The breaker exists so a host that is already struggling is not leaned on. The
// interesting moment is the one just after the cooldown, which is where letting
// everybody through at once undoes the whole thing.

func clocked(threshold int, cooldown time.Duration) (*breaker, *time.Time) {
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)
	b := newBreaker(threshold, cooldown)
	b.now = func() time.Time { return now }
	return b, &now
}

func TestItOpensAfterConsecutiveFailures(t *testing.T) {
	b, _ := clocked(3, time.Minute)
	for i := range 2 {
		if opened := b.record(false); opened {
			t.Fatalf("opened after %d failures, want 3", i+1)
		}
		if !b.allow() {
			t.Fatalf("closed after %d failures", i+1)
		}
	}
	if !b.record(false) {
		t.Fatal("the third failure did not open it")
	}
	if b.allow() {
		t.Error("still letting requests through after opening")
	}
}

func TestOneSuccessCloses(t *testing.T) {
	b, _ := clocked(2, time.Minute)
	b.record(false)
	b.record(false)
	b.record(true)
	if !b.allow() {
		t.Error("a success did not close it")
	}
}

// After the cooldown exactly one caller goes through. Letting all of them
// through — which is what resetting the counters in allow did — sends the whole
// worker pool at a host that has just spent the cooldown not answering, and the
// breaker has to discover the outage again from scratch.
func TestOnlyOneProbeGoesThroughAfterCooldown(t *testing.T) {
	b, now := clocked(1, time.Minute)
	b.record(false)
	if b.allow() {
		t.Fatal("open breaker allowed a request")
	}

	*now = now.Add(2 * time.Minute)
	if !b.allow() {
		t.Fatal("the cooldown elapsed and nothing was let through")
	}
	if b.allow() {
		t.Error("a second caller went through while the probe was still out")
	}
}

// A probe that fails shuts the door for another cooldown rather than leaving it
// ajar for everyone queued behind it.
func TestAFailedProbeClosesTheDoorAgain(t *testing.T) {
	b, now := clocked(1, time.Minute)
	b.record(false)
	*now = now.Add(2 * time.Minute)

	if !b.allow() {
		t.Fatal("no probe")
	}
	b.record(false)
	if b.allow() {
		t.Error("the door stayed open after the probe failed")
	}

	*now = now.Add(2 * time.Minute)
	if !b.allow() {
		t.Error("a second cooldown never elapsed; the host would never be tried again")
	}
}

func TestASucceedingProbeReopensForEverybody(t *testing.T) {
	b, now := clocked(1, time.Minute)
	b.record(false)
	*now = now.Add(2 * time.Minute)

	if !b.allow() {
		t.Fatal("no probe")
	}
	b.record(true)
	if !b.allow() || !b.allow() {
		t.Error("the host answered and the rest are still held back")
	}
}
