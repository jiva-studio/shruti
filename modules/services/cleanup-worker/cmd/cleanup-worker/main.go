// Lectorium cleanup-worker.
//
// Choreography consumer for cross-service domain events emitted via the
// app.outbox table + pg_notify channel `outbox`. Producers (auth, …)
// INSERT a row inside their business transaction; this worker picks it
// up, runs the registered side-effects, marks processed.
//
// Entry behavior:
//
//	/cleanup-worker           — start the consumer loop (default).
//	/cleanup-worker healthz   — self-call /healthz on localhost; exit 0/1.
//	                            Used by Docker HEALTHCHECK on the
//	                            FROM-scratch image.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/jiva-studio/lectorium/cleanup-worker/internal/config"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/cron"
	cwdb "github.com/jiva-studio/lectorium/cleanup-worker/internal/db"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/handlers"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/logging"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/observability"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/worker"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthz" {
		os.Exit(selfHealthz())
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logging.Setup("lectorium-cleanup-worker", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer bootCancel()

	pool, err := cwdb.NewPool(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", slog.String("err", err.Error()))
		os.Exit(1)
	}
	defer pool.Close()

	if err := cwdb.AssertSchemaReady(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "schema_not_ready", slog.String("err", err.Error()))
		os.Exit(1)
	}

	listenConn, err := cwdb.NewListenConn(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "listen_conn_failed", slog.String("err", err.Error()))
		os.Exit(1)
	}
	defer listenConn.Close(context.Background())

	// Build the handler registry. Add new entries as the project gains
	// more events to clean up after (media.deleted → S3 prefix wipe,
	// etc).
	lf := observability.NewClientFromEnv()
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", handlers.UserDeleted(lf))
	reg.Register("subscription.changed", handlers.SubscriptionChanged())

	slog.InfoContext(bootCtx, "handlers_registered",
		slog.Any("event_types", reg.KnownEventTypes()),
	)

	w := &worker.Worker{
		Pool:          pool,
		ListenConn:    listenConn,
		Registry:      reg,
		SweepInterval: cfg.SweepInterval,
	}

	// Top-level cancellation: SIGINT/SIGTERM cancels the worker context,
	// which unwinds the LISTEN goroutine + sweeper + HTTP server.
	runCtx, runCancel := context.WithCancel(context.Background())
	defer runCancel()

	srv := &http.Server{
		Addr:              ":" + cfg.HealthPort,
		Handler:           healthHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		slog.InfoContext(runCtx, "healthz_listening", slog.String("port", cfg.HealthPort))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.ErrorContext(runCtx, "healthz_server_error", slog.String("err", err.Error()))
			runCancel()
		}
	}()
	go func() {
		defer wg.Done()
		if err := w.Run(runCtx); err != nil {
			slog.ErrorContext(runCtx, "worker_run_failed", slog.String("err", err.Error()))
			runCancel()
		}
	}()

	// Scheduled anonymous-account cleanup. TTL=0 disables — handy for tests
	// and dev where we never want the cron mutating data. The DELETE here
	// triggers app.outbox writes via the auth.users AFTER DELETE trigger,
	// which the worker goroutine above will pick up to purge Langfuse
	// traces — closed loop, no extra wiring needed.
	if cfg.AnonCleanupTTL > 0 {
		c := &cron.AnonCleanup{
			Pool:     pool,
			Interval: cfg.AnonCleanupInterval,
			TTL:      cfg.AnonCleanupTTL,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
				slog.ErrorContext(runCtx, "anon_cleanup_run_failed", slog.String("err", err.Error()))
				runCancel()
			}
		}()
	} else {
		slog.InfoContext(bootCtx, "anon_cleanup_disabled",
			slog.String("reason", "CLEANUP_ANON_TTL=0"),
		)
	}

	// Sibling cron: signed-in long-tail TTL. Same outbox-event emission
	// path as anon_cleanup (DELETE on auth.users → user.deleted trigger
	// → Langfuse purge handler), different selection predicate
	// (must have a non-device identity). Dry-run gates the actual DELETE
	// — first deployment runs DryRun=true for 1-2 weeks of observation.
	if cfg.SignedInTTL > 0 {
		c := &cron.SignedInTTL{
			Pool:     pool,
			Interval: cfg.SignedInTTLInterval,
			TTL:      cfg.SignedInTTL,
			DryRun:   cfg.SignedInTTLDryRun,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
				slog.ErrorContext(runCtx, "signed_in_ttl_run_failed", slog.String("err", err.Error()))
				runCancel()
			}
		}()
	} else {
		slog.InfoContext(bootCtx, "signed_in_ttl_disabled",
			slog.String("reason", "CLEANUP_SIGNED_IN_TTL=0"),
		)
	}

	// Outbox-pending gauge poller. Independent goroutine — does not need
	// wg.Add since it returns silently on ctx cancellation (no critical
	// teardown the rest of shutdown depends on; the metric just stops
	// updating and the next scrape gets a stale `up` from Prometheus).
	observability.StartOutboxPendingPoller(runCtx, pool)

	// Retention sweep over processed bookkeeping rows (app.outbox +
	// auth.rc_webhook_events). Independent of the consumer loop — pure
	// daily DELETE on rows already past their TTL.
	ret := &handlers.Retention{
		Pool:             pool,
		Interval:         cfg.RetentionInterval,
		WebhookEventsTTL: cfg.RetentionWebhookEventsTTL,
		OutboxTTL:        cfg.RetentionOutboxTTL,
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := ret.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
			slog.ErrorContext(runCtx, "retention_run_failed", slog.String("err", err.Error()))
			runCancel()
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
		slog.Info("shutdown_start")
	case <-runCtx.Done():
		// Something else failed and triggered cancel; main exits via wg.Wait below.
	}

	runCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("healthz_shutdown_error", "err", err.Error())
	}

	// Wait for in-flight handlers to drain, bounded by shutdownCtx.
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		slog.Info("shutdown_done")
	case <-shutdownCtx.Done():
		slog.Warn("shutdown_timeout", "err", shutdownCtx.Err().Error())
	}
}

// healthHandler responds 200 on /healthz and exposes Prometheus
// metrics on /metrics. Process liveness only — the LISTEN goroutine's
// death is already escalated via runCancel above, so if the binary is
// still serving here, the consumer loop is alive too.
//
// /metrics is on the same mux so observability scrapers don't need a
// second port; this mirrors the auth service's pattern (auth router
// also collapses /metrics + /healthz onto one listener).
func healthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/metrics", promhttp.Handler())
	return mux
}

// selfHealthz hits /healthz on localhost from inside the FROM-scratch
// image (Docker HEALTHCHECK uses the cleanup-worker binary itself as the
// probe).
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
