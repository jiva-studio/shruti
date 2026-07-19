// Lectorium ingest worker — the STATELESS heavy-lifting side of the
// personal-library pipeline. It consumes `ingest.work` (dispatched by the
// orchestrator), downloads + transcribes + reviews + stores the audio, and
// reports progress and the terminal outcome on `ingest.result`. It owns no
// database and tracks no retries — the orchestrator is the source of truth.
//
// Single Go binary with subcommands (mirrors services/orchestrator, MINUS
// migrate — the worker has no schema of its own):
//
//	ingest serve     — start the HTTP server + broker consumer (default)
//	ingest healthz   — self-call /healthz over localhost; exit 0/1
//	                   (Docker HEALTHCHECK probe)
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

	"github.com/jiva-studio/lectorium/ingest/internal/config"
	logpkg "github.com/jiva-studio/lectorium/ingest/internal/logging"
	"github.com/jiva-studio/lectorium/ingest/internal/wire"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "healthz":
		os.Exit(selfHealthz())
	case "serve":
		runServe()
	default:
		slog.Error("unknown subcommand", "cmd", cmd)
		os.Exit(2)
	}
}

// runServe starts the HTTP server and the broker consumer.
func runServe() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logpkg.Setup("lectorium-ingest", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	deps, err := wire.Build(bootCtx, cfg)
	if err != nil {
		slog.ErrorContext(bootCtx, "wire_build_failed", "err", err.Error())
		os.Exit(1)
	}
	if deps.Redis != nil {
		defer deps.Redis.Close()
	}

	// Broker-driven pipeline: the consumer processes ingest.work for the process
	// lifetime and is torn down when the root context is cancelled on shutdown.
	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	if deps.Consumer != nil {
		go func() {
			if err := deps.Consumer.Run(workerCtx); err != nil && !errors.Is(err, context.Canceled) {
				slog.Error("consumer_stopped", "err", err.Error())
			}
		}()
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
	workerCancel() // stop the consumer before draining HTTP

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("shutdown_done")
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe.
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8088"
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
