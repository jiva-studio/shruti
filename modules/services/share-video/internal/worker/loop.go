// Package worker owns the polling loop that pulls render tasks off
// public.tasks and drives them through pipeline.Render. Concurrency
// is deliberately 1 — ffmpeg at 720p already pulls ~1.75 vCPU on the
// host, so two parallel renders would starve chat/share-audio.
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/shruti-share-video/internal/db"
	"github.com/akdasa-studios/shruti-share-video/internal/logx"
	"github.com/akdasa-studios/shruti-share-video/internal/pipeline"
	"github.com/akdasa-studios/shruti-share-video/internal/types"
)

const (
	pollInterval = 2500 * time.Millisecond
	leaseMs      = int64(10 * 60 * 1000) // 10 min — ffmpeg pass takes <2 min in practice
)

// Worker holds the dependencies the loop needs.
type Worker struct {
	Pool     *pgxpool.Pool
	Renderer *pipeline.Renderer
	TempRoot string
	Log      *slog.Logger // child logger with component=worker

	stopOnce sync.Once
	done     chan struct{}
	running  chan struct{}
}

// New builds a Worker with a child logger that tags every line with
// `component=worker` + `worker_id=<host>:<pid>`.
func New(pool *pgxpool.Pool, renderer *pipeline.Renderer, tempRoot string, base *slog.Logger) *Worker {
	host, _ := os.Hostname()
	workerID := fmt.Sprintf("%s:%d", host, os.Getpid())
	return &Worker{
		Pool:     pool,
		Renderer: renderer,
		TempRoot: tempRoot,
		Log:      base.With("component", "worker", "worker_id", workerID),
		done:     make(chan struct{}),
		running:  make(chan struct{}),
	}
}

// Start launches the polling goroutine. Returns immediately.
func (w *Worker) Start(ctx context.Context) {
	go w.run(ctx)
}

// Stop signals the loop to exit and waits for the in-flight task to
// finish. Bounded by the context the caller passes.
func (w *Worker) Stop(ctx context.Context) error {
	w.stopOnce.Do(func() { close(w.done) })
	select {
	case <-w.running:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) run(ctx context.Context) {
	defer close(w.running)
	w.Log.Info("worker_started", "kind", db.TaskKind)

	// Revive any tasks whose lease lapsed (covers a previous crash
	// mid-render). Kind-agnostic on purpose.
	if n, err := db.ReviveExpired(ctx, w.Pool); err != nil {
		w.Log.Error("revive_failed", "err", err.Error())
	} else if n > 0 {
		w.Log.Info("lease_revival", "count", n)
	}

	for {
		select {
		case <-w.done:
			w.Log.Info("worker_stopped")
			return
		case <-ctx.Done():
			w.Log.Info("worker_stopped", "ctx", ctx.Err().Error())
			return
		default:
		}

		task, err := db.LeaseOne(ctx, w.Pool, hostPidLeaseID(), leaseMs)
		if err != nil {
			w.Log.Error("lease_failed", "err", err.Error())
			if !sleepOrStop(ctx, w.done, pollInterval) {
				return
			}
			continue
		}
		if task == nil {
			if !sleepOrStop(ctx, w.done, pollInterval) {
				return
			}
			continue
		}

		w.processOne(ctx, task)
	}
}

func (w *Worker) processOne(parentCtx context.Context, task *db.TaskRow) {
	start := time.Now()
	taskLog := w.Log.With("task_id", task.ID)
	ctx := logx.Into(parentCtx, taskLog)

	workerID := hostPidLeaseID()
	tempDir := filepath.Join(w.TempRoot, "share-video-"+task.ID)
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		w.fail(ctx, task, workerID, fmt.Errorf("mkdir tempdir: %w", err))
		return
	}
	defer func() {
		if err := os.RemoveAll(tempDir); err != nil {
			taskLog.Warn("tempdir_cleanup_failed", "err", err.Error())
		}
	}()

	out, err := w.Renderer.Render(ctx, pipeline.Input{
		Request: task.Payload.Request,
		VideoID: task.ID,
		TempDir: tempDir,
	})
	if err != nil {
		w.fail(ctx, task, workerID, err)
		return
	}
	if err := db.Finish(parentCtx, w.Pool, task.ID, workerID, types.TaskResult{URL: out.URL, OutputKey: out.OutputKey}); err != nil {
		if errors.Is(err, db.ErrLeaseLost) {
			// ReviveExpired flipped this task back to 'pending'
			// while the render was in flight — another worker
			// now owns it. Don't clobber its outcome.
			taskLog.Warn("lease_lost_at_finish", "task_id", task.ID, "url", out.URL)
			return
		}
		taskLog.Error("task_finish_failed", "err", err.Error())
		return
	}
	taskLog.Info("task_done", "dur_ms", time.Since(start).Milliseconds(), "url", out.URL)
}

func (w *Worker) fail(ctx context.Context, task *db.TaskRow, workerID string, cause error) {
	msg := cause.Error()
	// Use parent context (NOT cancelled-ones) so the UPDATE still goes
	// through if the cause was a ctx cancel mid-render.
	bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	willRetry, err := db.Fail(bgCtx, w.Pool, task.ID, workerID, task.Attempts, task.MaxAttempts, msg)
	if errors.Is(err, db.ErrLeaseLost) {
		// Lease was revived under us while we ran. Another worker
		// owns the retry; do nothing here.
		logx.From(ctx).Warn("lease_lost_at_fail",
			"task_id", task.ID,
			"attempts", task.Attempts,
			"err", msg,
		)
		return
	}
	logx.From(ctx).Error("task_fail",
		"task_id", task.ID,
		"attempts", task.Attempts,
		"will_retry", willRetry,
		"err", msg,
	)
	if err != nil {
		logx.From(ctx).Error("task_fail_update_failed", "err", err.Error())
	}
}

// hostPidLeaseID matches Node's WORKER_ID = `${os.hostname()}:${pid}`.
// Kept as a function so a test can inject a deterministic value.
var hostPidLeaseID = func() string {
	host, _ := os.Hostname()
	return fmt.Sprintf("%s:%d", host, os.Getpid())
}

func sleepOrStop(ctx context.Context, done chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-done:
		return false
	case <-ctx.Done():
		return false
	}
}

