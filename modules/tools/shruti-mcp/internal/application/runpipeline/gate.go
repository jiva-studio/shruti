package runpipeline

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
)

// Gate caps how many files may be inside a given stage at once.
//
// The pool is file-level — one worker carries one file through every stage —
// so its size is a single number serving stages with opposite needs. Transcribe
// waits on a remote box and wants many workers idle in parallel; normalize and
// commit hammer the local disk, where a mechanical drive turns concurrent
// access into seeks and loses most of its throughput. Measured on this import:
// six workers gave the disk 9 MB/s and a commit took 17s per track; one worker
// gave 17 MB/s and 6s.
//
// So the limit belongs to the stage, not to the pool.
type Gate struct {
	slots map[pipeline.Stage]chan struct{}
}

// NewGate builds a gate from a stage→limit map. A stage absent from the map,
// or given a limit below 1, is left unrestricted.
func NewGate(limits map[pipeline.Stage]int) *Gate {
	g := &Gate{slots: map[pipeline.Stage]chan struct{}{}}
	for stage, n := range limits {
		if n >= 1 {
			g.slots[stage] = make(chan struct{}, n)
		}
	}
	return g
}

// Enter blocks until the stage has room. The returned func releases the slot
// and is safe to call once; it is a no-op for an unrestricted stage.
func (g *Gate) Enter(ctx context.Context, stage pipeline.Stage) (release func(), err error) {
	if g == nil {
		return func() {}, nil
	}
	ch, ok := g.slots[stage]
	if !ok {
		return func() {}, nil
	}
	select {
	case ch <- struct{}{}:
		var once bool
		return func() {
			if !once {
				once = true
				<-ch
			}
		}, nil
	case <-ctx.Done():
		return func() {}, ctx.Err()
	}
}
