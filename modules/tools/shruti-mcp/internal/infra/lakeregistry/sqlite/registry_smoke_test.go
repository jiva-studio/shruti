//go:build smoke

package sqliteregistry

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

type smokeContentionMinter struct{ next atomic.Int64 }

func (m *smokeContentionMinter) MintTail() string {
	// 12 chars, alnum, deterministic per test run.
	n := m.next.Add(1)
	return fmt.Sprintf("smoke%07d", n)
}

// TestContentionSetStageNoFails reproduces the live failure mode that
// motivated P4-C: 4 goroutines × N SetStage transactions on a single
// connection (SetMaxOpenConns(1)). Before the fix (busy_timeout=5s, no
// retry) this would reject ~33% with SQLITE_BUSY. After (busy_timeout=60s
// + sqliteutil.WithRetry) every transaction must commit.
func TestContentionSetStageNoFails(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "registry-smoke.db")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	reg, err := New(ctx, dbPath, &smokeContentionMinter{})
	if err != nil {
		t.Fatalf("open registry: %v", err)
	}
	t.Cleanup(func() { _ = reg.Close() })

	const tracksPerWorker = 250
	const workers = 4
	totalTracks := tracksPerWorker * workers

	// Pre-ingest each track so SetStage has a files row to reference. Done
	// serially to remove ingest contention from the test — we're measuring
	// SetStage contention specifically.
	ids := make([]track.Id, totalTracks)
	for i := 0; i < totalTracks; i++ {
		path := fmt.Sprintf("%s/track%05d.mp3", dir, i)
		id, _, err := reg.UpsertFile(ctx, track.SourceFile{
			Path: path, SHA256: fmt.Sprintf("sha%05d", i), Size: 1024,
		})
		if err != nil {
			t.Fatalf("ingest %d: %v", i, err)
		}
		ids[i] = id
	}

	// 4 goroutines, each pushes its slice through ingested → normalized →
	// metadata → transcribed (per-language) → reviewed → committed. That's
	// six SetStage calls per track; cascadeReset on each Done multiplies
	// the lock window. Mirrors the live pipeline_run pattern.
	stages := []pipeline.Key{
		{Stage: pipeline.StageIngested},
		{Stage: pipeline.StageNormalized},
		{Stage: pipeline.StageMetadataExtracted},
		{Stage: pipeline.StageTranscribed, Variant: "en"},
		{Stage: pipeline.StageReviewed, Variant: "en"},
		{Stage: pipeline.StageCommitted, Variant: "en"},
	}

	var wg sync.WaitGroup
	failures := atomic.Int64{}
	start := time.Now()
	for w := 0; w < workers; w++ {
		w := w
		wg.Add(1)
		go func() {
			defer wg.Done()
			lo := w * tracksPerWorker
			hi := lo + tracksPerWorker
			for i := lo; i < hi; i++ {
				for _, key := range stages {
					if err := reg.SetStage(ctx, ids[i], key, pipeline.StatusDone, nil, ""); err != nil {
						t.Errorf("worker %d track %d %s: %v", w, i, key.Stage, err)
						failures.Add(1)
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)

	if got := failures.Load(); got != 0 {
		t.Fatalf("expected 0 SetStage failures across %d×%d ops, got %d", workers, tracksPerWorker*len(stages), got)
	}
	t.Logf("workers=%d tracks=%d stages=%d total=%d elapsed=%v",
		workers, totalTracks, len(stages), totalTracks*len(stages), elapsed)
}
