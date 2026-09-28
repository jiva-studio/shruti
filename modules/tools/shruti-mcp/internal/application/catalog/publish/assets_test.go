package publish

import (
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

// headUploader answers HEAD from a fixed set of held keys, so a test can
// describe exactly which advertised transcripts the target does not have.
type headUploader struct {
	held    map[string]bool
	headErr error

	mu     sync.Mutex
	probes int
	// onProbe, if set, runs after each probe is counted — a hook for
	// cancelling the run mid-sweep.
	onProbe func(n int)
}

func (u *headUploader) Name() string   { return "fake" }
func (u *headUploader) Bucket() string { return "fake-bucket" }
func (u *headUploader) Put(context.Context, string, string, io.Reader, int64) error {
	return nil
}
func (u *headUploader) GetJSON(context.Context, string, any) (bool, error) { return false, nil }
func (u *headUploader) Get(context.Context, string) ([]byte, bool, error)  { return nil, false, nil }
func (u *headUploader) Head(_ context.Context, key string) (int64, string, bool, error) {
	u.mu.Lock()
	u.probes++
	n := u.probes
	hook := u.onProbe
	u.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	if u.headErr != nil {
		return 0, "", false, u.headErr
	}
	if u.held[key] {
		return 1, "", true, nil
	}
	return 0, "", false, nil
}

func (u *headUploader) probeCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.probes
}

func transcriptPath(i int) string {
	return fmt.Sprintf("public/tracks/track_%03d/transcripts/ru.json", i)
}

func heldAll(paths []string) map[string]bool {
	out := map[string]bool{}
	for _, p := range paths {
		out[p] = true
	}
	return out
}

func TestVerifyPassesWhenTargetHoldsEverything(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	target := &headUploader{held: heldAll(paths)}

	check, missing, err := verifyTranscriptAssets(t.Context(), paths, target, assetCheckOpts{Concurrency: 4})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 0 || check.Pruned != 0 {
		t.Errorf("missing=%v pruned=%d, want none", missing, check.Pruned)
	}
	if check.Checked != 2 || target.probeCount() != 2 {
		t.Errorf("checked=%d probes=%d, want 2/2", check.Checked, target.probeCount())
	}
}

// The reported case: a catalog advertising an `en.json` that was never
// uploaded is reported for pruning.
func TestVerifyReportsUnbackedTranscript(t *testing.T) {
	phantom := "public/tracks/track_DuNeWMKFeWts/transcripts/en.json"
	backed := "public/tracks/track_DuNeWMKFeWts/transcripts/ru.json"
	paths := []string{phantom, backed}
	target := &headUploader{held: map[string]bool{backed: true}}

	check, missing, err := verifyTranscriptAssets(t.Context(), paths, target, assetCheckOpts{Concurrency: 4})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 1 || missing[0] != phantom {
		t.Fatalf("missing=%v, want [%s]", missing, phantom)
	}
	if check.Pruned != 1 || len(check.PrunedSample) != 1 {
		t.Errorf("check=%+v, want 1 pruned", check)
	}
}

// force_prune is the narrow escape from the budget: over-budget phantoms
// are dropped from the published copy instead of the publish being refused,
// which is what skip_asset_check would otherwise force (shipping all of
// them). The refusal still stands without it.
func TestForcePruneWaivesTheBudget(t *testing.T) {
	var paths []string
	for i := 0; i < 200; i++ {
		paths = append(paths, transcriptPath(i))
	}
	held := heldAll(paths)
	var phantoms []string
	for i := 0; i < 60; i++ { // over max(50, 5% of 200)
		delete(held, paths[i])
		phantoms = append(phantoms, paths[i])
	}

	if _, _, err := verifyTranscriptAssets(t.Context(), paths,
		&headUploader{held: held}, assetCheckOpts{Concurrency: 8}); err == nil {
		t.Fatal("60 phantoms over budget: expected a refusal without force")
	}

	check, missing, err := verifyTranscriptAssets(t.Context(), paths,
		&headUploader{held: held}, assetCheckOpts{Concurrency: 8, Force: true})
	if err != nil {
		t.Fatalf("force verify: %v", err)
	}
	if len(missing) != len(phantoms) || check.Pruned != len(phantoms) || !check.Forced {
		t.Errorf("check=%+v missing=%d, want %d pruned and forced", check, len(missing), len(phantoms))
	}
}

// A cancelled sweep probed a prefix of the corpus at most, so it is a
// verdict on nothing — reporting the unprobed remainder as present would
// let a half-checked catalog ship.
func TestVerifyRejectsACancelledSweep(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if _, _, err := verifyTranscriptAssets(ctx, paths, &headUploader{}, assetCheckOpts{Concurrency: 2}); err == nil {
		t.Fatal("expected a cancelled asset check to report an error")
	}
}

// The workers leave the moment ctx is done, so the producer's send has to
// watch ctx too — otherwise it blocks on a channel nobody reads again,
// forever, while publish is holding OpMutex. That hang wedges the whole
// tool, so it is asserted with a hard deadline rather than left to the
// package timeout.
func TestMissingAssetsReturnsWhenContextIsCancelled(t *testing.T) {
	var paths []string
	for i := 0; i < 500; i++ {
		paths = append(paths, transcriptPath(i))
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	target := &headUploader{
		held:    heldAll(paths),
		onProbe: func(int) { cancel() },
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		missingAssets(ctx, target, paths, 2)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("missingAssets never returned after the context was cancelled — " +
			"the producer is blocked sending to workers that already left")
	}
	if n := target.probeCount(); n >= len(paths) {
		t.Errorf("probed %d of %d paths — the sweep did not stop on cancel", n, len(paths))
	}
}

// A target answering "not found" wholesale is broken, not a source of
// stale rows — shipping a catalog stripped of the corpus would take chat
// search down.
func TestVerifyRefusesWhenTooMuchIsMissing(t *testing.T) {
	var paths []string
	for i := 0; i < 200; i++ {
		paths = append(paths, transcriptPath(i))
	}
	target := &headUploader{held: map[string]bool{}}

	_, _, err := verifyTranscriptAssets(t.Context(), paths, target, assetCheckOpts{Concurrency: 8})
	if err == nil {
		t.Fatal("expected publish to refuse, got nil error")
	}
}

// An erroring probe is not evidence of absence.
func TestVerifyKeepsUnverifiablePaths(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	target := &headUploader{headErr: fmt.Errorf("connection reset")}

	check, missing, err := verifyTranscriptAssets(t.Context(), paths, target, assetCheckOpts{Concurrency: 4})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 0 || check.Unverifiable != 2 {
		t.Errorf("missing=%v unverifiable=%d, want 0/2", missing, check.Unverifiable)
	}
}
