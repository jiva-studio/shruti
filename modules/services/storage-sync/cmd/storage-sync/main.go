// Lectorium storage-sync — keeps the Russia mirror (Yandex Object Storage)
// faithful to the source of truth (Bunny Edge Storage).
//
// Two drivers run side by side:
//
//   - a periodic FULL pass (SYNC_INTERVAL) that walks Bunny, diffs the mirror by
//     checksum and ships what changed — the reconciler and the safety net;
//   - a `track.events` CONSUMER that, on `track.ready`, mirrors that track's
//     audio + transcript immediately. Without it a user served by the mirror
//     would see a track the app already calls "ready" whose audio 404s until the
//     next full pass — up to an hour.
//
// Change detection uses Bunny's per-object SHA-256, stamped onto the mirrored
// object as `x-amz-meta-bunny-sha256`, so a pass never re-downloads to compare.
// Legacy objects from the retired S3→Yandex rclone workflow carry no stamp and
// are matched by size instead.
//
// SYNC_INTERVAL=0 runs a single pass and exits (one-shot job mode).
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jiva-studio/lectorium-storage-sync/internal/config"
	logpkg "github.com/jiva-studio/lectorium-storage-sync/internal/logging"
	"github.com/jiva-studio/lectorium-storage-sync/internal/wire"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err.Error())
		os.Exit(2)
	}
	logpkg.Setup("lectorium-storage-sync", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	deps, err := wire.Build(bootCtx, cfg)
	bootCancel()
	if err != nil {
		slog.Error("wire_build_failed", "err", err.Error())
		os.Exit(1)
	}
	if deps.Redis != nil {
		defer deps.Redis.Close()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The event-driven fast path runs for the process lifetime.
	if deps.Consumer != nil {
		go func() {
			if err := deps.Consumer.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.Error("consumer_stopped", "err", err.Error())
			}
		}()
	}

	// One-shot mode: a single pass, then exit (the consumer never starts here in
	// practice, since a job deployment has no broker configured).
	if cfg.Interval <= 0 {
		runPass(ctx, deps)
		return
	}

	go runPeriodic(ctx, deps, cfg.Interval)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	slog.Info("shutdown_start")
	cancel()
	slog.Info("shutdown_done")
}

// runPeriodic runs a full pass immediately, then every interval until ctx ends.
func runPeriodic(ctx context.Context, deps *wire.Deps, interval time.Duration) {
	for {
		runPass(ctx, deps)
		t := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// runPass executes one reconciling pass and logs the outcome. A failed pass is
// logged, never fatal — the next tick retries.
func runPass(ctx context.Context, deps *wire.Deps) {
	t0 := time.Now()
	res, err := deps.Mirror.FullPass(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "sync_pass_failed",
			"err", err.Error(), "source", res.Source, "copied", res.Copied,
			"failed", res.Failed, "seconds", int(time.Since(t0).Seconds()))
		return
	}
	slog.InfoContext(ctx, "sync_pass_done",
		"source", res.Source, "copied", res.Copied, "deleted", res.Deleted,
		"seconds", int(time.Since(t0).Seconds()))
}
