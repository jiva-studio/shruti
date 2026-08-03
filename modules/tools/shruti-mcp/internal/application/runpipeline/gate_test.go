package runpipeline

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
)

// A gated stage never has more than its limit inside at once.
func TestGateCapsConcurrency(t *testing.T) {
	g := NewGate(map[pipeline.Stage]int{pipeline.StageCommitted: 1})
	var inside, peak int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rel, err := g.Enter(context.Background(), pipeline.StageCommitted)
			if err != nil {
				t.Error(err)
				return
			}
			n := atomic.AddInt32(&inside, 1)
			for {
				p := atomic.LoadInt32(&peak)
				if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			atomic.AddInt32(&inside, -1)
			rel()
		}()
	}
	wg.Wait()
	if peak != 1 {
		t.Fatalf("peak concurrency = %d, want 1", peak)
	}
}

// An unlisted stage is not restricted, and a nil gate is inert.
func TestGateLeavesOtherStagesAlone(t *testing.T) {
	for _, g := range []*Gate{NewGate(map[pipeline.Stage]int{pipeline.StageCommitted: 1}), nil} {
		rel, err := g.Enter(context.Background(), pipeline.StageTranscribed)
		if err != nil {
			t.Fatal(err)
		}
		rel()
		rel() // releasing twice must not panic or free a slot it never took
	}
}

// A caller waiting for a slot gives up when its context does.
func TestGateHonoursContext(t *testing.T) {
	g := NewGate(map[pipeline.Stage]int{pipeline.StageNormalized: 1})
	rel, _ := g.Enter(context.Background(), pipeline.StageNormalized)
	defer rel()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := g.Enter(ctx, pipeline.StageNormalized); err == nil {
		t.Fatal("expected the second entrant to be refused once the context expired")
	}
}
