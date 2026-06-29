// Package worker hosts the in-process pool that drives runpipeline.UseCase.Run
// across many files concurrently. The pool is the only thing that calls Run
// in the daemon; MCP-tool handlers submit Items and never block on the
// pipeline themselves.
//
// Concurrency model: file-level (one worker = one full pipeline for one
// file). External-resource limits (e.g. M-box transcribe cap) live as
// throttled adapter wrappers (see throttled.go), not in the pool.
package worker

import (
	"context"
	"errors"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/runpipeline"
)

// ErrQueueFull is returned by Submit when the pool's queue buffer is at
// capacity. Callers (typically pipeline_run) collect rejected items and
// surface them in the result alongside accepted ones.
var ErrQueueFull = errors.New("worker pool: queue full")

// Item is one path queued for processing.
type Item struct {
	Path string
	Opts runpipeline.Options
}

// runner is the narrow contract Pool needs from runpipeline.UseCase. Kept
// as an interface (not the concrete struct) so tests can inject a panicking
// fake to exercise the recover path. runpipeline.UseCase already has a
// matching Run method, so main.go wires the real use case in without any
// adapter shim.
type runner interface {
	Run(ctx context.Context, path string, opts runpipeline.Options) runpipeline.FileSummary
}

// Running describes a path currently being processed by a worker.
type Running struct {
	Path    string    `json:"path"`
	TrackId string    `json:"track_id,omitempty"`
	Since   time.Time `json:"since"`
}

// Status is what the MCP `pipeline_status` tool returns.
type Status struct {
	Workers     int       `json:"workers"`
	QueueDepth  int       `json:"queue_depth"`
	Running     []Running `json:"running"`
	UptimeSecs  int64     `json:"uptime_s"`
	StartedUnix int64     `json:"started_at"`
}

// Pool is the file-level worker pool driving runpipeline.UseCase.
type Pool struct {
	uc      runner
	queue   chan Item
	workers int

	startedAt time.Time

	mu      sync.Mutex
	running map[int]Running // workerID → currently-processed item
}

// New constructs a pool. workers defaults to 4, queueSize to 1024.
func New(uc runner, workers, queueSize int) *Pool {
	if workers <= 0 {
		workers = 4
	}
	if queueSize <= 0 {
		queueSize = 1024
	}
	return &Pool{
		uc:        uc,
		queue:     make(chan Item, queueSize),
		workers:   workers,
		startedAt: time.Now(),
		running:   map[int]Running{},
	}
}

// Start launches `workers` goroutines that drain the queue until ctx is done.
// Returns immediately. The caller owns ctx and is expected to cancel it on
// shutdown so workers exit cleanly.
func (p *Pool) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		go p.workerLoop(ctx, i)
	}
}

// Submit enqueues a path non-blockingly. Returns ErrQueueFull when the
// queue buffer is at capacity (default 1024) so a 10k-track pipeline_run
// doesn't sit on the MCP request waiting for headroom — caller collects
// rejections and re-submits later. Returns ctx.Err() if cancelled.
func (p *Pool) Submit(ctx context.Context, item Item) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case p.queue <- item:
		return nil
	default:
		return ErrQueueFull
	}
}

// Status returns a snapshot of the pool state for the MCP `pipeline_status`
// tool. Cheap — read-only on the queue + a short critical section over the
// running map.
//
// `len(p.queue)` is read without the mutex. Go guarantees `len` on a channel
// is concurrent-safe (race-detector clean); the value is approximate the
// moment it's returned, but a Status() snapshot is approximate by design.
func (p *Pool) Status() Status {
	p.mu.Lock()
	rs := make([]Running, 0, len(p.running))
	for _, r := range p.running {
		rs = append(rs, r)
	}
	p.mu.Unlock()
	return Status{
		Workers:     p.workers,
		QueueDepth:  len(p.queue),
		Running:     rs,
		UptimeSecs:  int64(time.Since(p.startedAt).Seconds()),
		StartedUnix: p.startedAt.Unix(),
	}
}

func (p *Pool) workerLoop(ctx context.Context, id int) {
	for {
		select {
		case <-ctx.Done():
			return
		case item, ok := <-p.queue:
			if !ok {
				return
			}
			p.runItem(ctx, id, item)
		}
	}
}

// runItem wraps one pipeline run for a single queued path. The defer chain
// guarantees three things in order: (1) the worker stays alive past a panic
// inside p.uc.Run (without recover, a panic in any downstream stage —
// LLM call, ffmpeg subprocess, etc. — kills the goroutine and the worker
// silently disappears from the pool); (2) the running map gets cleaned up
// even on panic so pipeline_status doesn't show a phantom "running" entry
// forever; (3) the panic is logged with a stack trace so it can be diagnosed
// (registry stage state is left as-is — usually `running`, since the panic
// bypassed the use case's own error path; on the next worker pass
// MarkInterruptedAsFailed will flip it to failed at startup).
func (p *Pool) runItem(ctx context.Context, id int, item Item) {
	defer func() {
		p.markIdle(id)
		if r := recover(); r != nil {
			log.Printf("[worker %d] panic on %s: %v\n%s", id, item.Path, r, debug.Stack())
		}
	}()
	p.markRunning(id, item.Path)
	// runpipeline.Run never returns a Go error — failures are encoded
	// in the FileSummary.Status. So we ignore the return: the registry
	// stages table is the source of truth for callers.
	_ = p.uc.Run(ctx, item.Path, item.Opts)
}

func (p *Pool) markRunning(id int, path string) {
	p.mu.Lock()
	p.running[id] = Running{Path: path, Since: time.Now()}
	p.mu.Unlock()
}

func (p *Pool) markIdle(id int) {
	p.mu.Lock()
	delete(p.running, id)
	p.mu.Unlock()
}
