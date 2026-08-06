package store_test

import (
	"context"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// Only one process crawls. Two would be two per-host rate limiters, each
// correctly observing a gap the other knows nothing about, at somebody else's
// site.
func TestOnlyOneProcessLeads(t *testing.T) {
	_, pool := testRepo(t)
	ctx := context.Background()

	first, err := store.Lead(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if first == nil {
		t.Fatal("nobody could take the lock on an empty database")
	}
	t.Cleanup(first.Release)

	second, err := store.Lead(ctx, pool)
	if err != nil {
		t.Fatalf("a follower reported an error rather than standing down: %v", err)
	}
	if second != nil {
		t.Fatal("two processes both believe they are the crawler")
	}
}

// A leader that goes away hands over without anyone clearing anything: the lock
// is session-scoped, so a process that dies releases it.
func TestTheClaimPassesOnWhenItIsReleased(t *testing.T) {
	_, pool := testRepo(t)
	ctx := context.Background()

	first, err := store.Lead(ctx, pool)
	if err != nil || first == nil {
		t.Fatalf("= %v, %v", first, err)
	}
	first.Release()

	second, err := store.Lead(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if second == nil {
		t.Fatal("the claim was never given up; nothing would crawl again until a restart")
	}
	second.Release()
}

// Releasing what was never taken, or twice, is a no-op — the shutdown path
// calls it unconditionally.
func TestReleasingNothingIsSafe(t *testing.T) {
	_, pool := testRepo(t)
	var absent *store.Leader
	absent.Release()

	held, err := store.Lead(context.Background(), pool)
	if err != nil || held == nil {
		t.Fatalf("= %v, %v", held, err)
	}
	held.Release()
	held.Release()
}
