// Lectorium orchestrator service — a generic job orchestrator whose first
// scenario is personal-library ingest (fetch -> transcribe -> review -> store
// -> emit events). See docs: architecture/personal-library.md.
//
// Single Go binary with subcommands (mirrors services/profile):
//
//	orchestrator serve     — start the HTTP server (default if no subcommand)
//	orchestrator migrate   — apply embedded migrations once, then exit
//	orchestrator healthz   — self-call /healthz over localhost; exit 0/1
//	                         (Docker HEALTHCHECK on the FROM-scratch image)
//
// Like profile, the orchestrator owns its OWN Postgres and carries embedded
// self-run migrations — it is NOT wired into the central `migrator`.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jiva-studio/lectorium/orchestrator/internal/config"
	"github.com/jiva-studio/lectorium/orchestrator/internal/handler"
	logpkg "github.com/jiva-studio/lectorium/orchestrator/internal/logging"
	"github.com/jiva-studio/lectorium/orchestrator/internal/store"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "healthz":
		os.Exit(selfHealthz())
	case "migrate":
		os.Exit(runMigrate())
	case "serve":
		runServe()
	default:
		slog.Error("unknown subcommand", "cmd", cmd)
		os.Exit(2)
	}
}

// runMigrate applies embedded migrations once, then exits. Advisory-locked so
// parallel one-shot containers don't collide.
func runMigrate() int {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("lectorium-orchestrator", cfg.Env, cfg.ServiceVersion)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(ctx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()

	if err := store.Migrate(ctx, pool); err != nil {
		slog.ErrorContext(ctx, "migrate_failed", "err", err.Error())
		return 1
	}
	slog.InfoContext(ctx, "migrate_done")
	return 0
}

// runServe starts the HTTP server. It refuses to boot until the schema is
// current (migrations must have run first) so it never serves against a
// half-built database.
func runServe() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logpkg.Setup("lectorium-orchestrator", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	pool, err := store.Connect(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()

	// Apply embedded migrations on boot (advisory-locked + idempotent, safe on
	// every start and across replicas). SchemaReady is a final guard against a
	// partial apply. `orchestrator migrate` stays available for manual ops.
	if err := store.Migrate(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "migrate_failed", "err", err.Error())
		os.Exit(1)
	}
	if err := store.SchemaReady(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "schema_not_ready", "err", err.Error())
		os.Exit(1)
	}

	root := handler.NewRouter(handler.RouterDeps{Pool: pool})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("server_listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server_error", "err", err.Error())
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	slog.Info("shutdown_start")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("shutdown_done")
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe for the
// FROM-scratch image (no shell/curl inside).
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8086"
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
