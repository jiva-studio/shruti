// Lectorium discovery — an index of lecture audio published on external
// archives.
//
// It fetches a page, flattens it to text, collects every media URL in it, and
// hands each one plus the text around it to a model that says what the
// recording is. Nothing about any particular site lives in this binary: a
// source is a seed URL.
//
// It does not mirror audio and it does not transcribe. Handing a discovered
// media URL to the existing ingest pipeline is a separate, deliberate act.
//
// Subcommands:
//
//	discovery serve         — start the HTTP server (default)
//	discovery migrate       — apply embedded migrations once, then exit
//	discovery healthz       — self-call /healthz over localhost; exit 0/1
//	discovery parse <url>   — fetch one URL, print what came out, write nothing
//	                          (no credentials: use POST /discovery/parse for those)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/config"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
	logpkg "github.com/jiva-studio/lectorium/discovery/internal/logging"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
	"github.com/jiva-studio/lectorium/discovery/internal/wire"
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
	case "parse":
		os.Exit(runParse(os.Args[2:]))
	case "serve":
		runServe()
	default:
		slog.Error("unknown subcommand", "cmd", cmd)
		os.Exit(2)
	}
}

// runParse fetches one URL and prints the three layers. It touches no database
// and writes nothing, so it works anywhere the network does.
func runParse(args []string) int {
	if len(args) == 0 {
		slog.Error("usage: discovery parse <url>")
		return 2
	}
	cfg := config.Load()
	logpkg.SetupTo(os.Stderr, "lectorium-discovery", cfg.Env, cfg.ServiceVersion)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// No database here, so no source and no credentials with it. For a page
	// behind an account, POST /discovery/parse with a "source" instead.
	layers, err := wire.BuildParse(ctx, cfg).URL(ctx, args[0], fetch.Request{})
	if err != nil {
		slog.ErrorContext(ctx, "parse_failed", "url", args[0], "err", err.Error())
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(layers); err != nil {
		return 1
	}
	return 0
}

func runMigrate() int {
	cfg := config.Load()
	if err := cfg.RequireDatabase(); err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("lectorium-discovery", cfg.Env, cfg.ServiceVersion)

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

// runServe starts the HTTP server. Starting the service crawls nothing: the
// scheduler is off unless switched on, and even then it only walks sources that
// are themselves enabled.
func runServe() {
	cfg := config.Load()
	if err := cfg.RequireDatabase(); err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logpkg.Setup("lectorium-discovery", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	deps, err := wire.Build(bootCtx, cfg)
	if err != nil {
		slog.ErrorContext(bootCtx, "wire_build_failed", "err", err.Error())
		os.Exit(1)
	}
	defer deps.Pool.Close()

	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	if deps.Scheduler != nil {
		slog.Info("scheduler_starting", "interval", cfg.ScheduleInterval.String())
		go deps.Scheduler.Start(workerCtx)
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           deps.Handler,
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
	workerCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("shutdown_done")
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe for the
// FROM-scratch image, which has no shell.
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8089"
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
