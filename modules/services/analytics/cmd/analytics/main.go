// Shruti analytics service — read-only reports over the profile DB.
//
// Single Go binary with two subcommands:
//
//	analytics serve      — start the HTTP server (default if no subcommand)
//	analytics healthz     — self-call /healthz over localhost; exit 0/1
//	                        (Docker HEALTHCHECK on the FROM-scratch image)
//
// It owns no schema and runs no migrations: reports are on-demand reads of
// profile.listening_sessions, cached in memory. All derived logic (rates,
// extrapolation, formatting) lives on the client that consumes the reports.
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

	// Embed the IANA timezone database in the binary. The final image is
	// FROM scratch (no OS zoneinfo), and reports accept a `tz` param that
	// time.LoadLocation must resolve — without this every named zone would
	// fail validation.
	_ "time/tzdata"

	"github.com/jiva-studio/shruti/analytics/internal/cache"
	"github.com/jiva-studio/shruti/analytics/internal/catalog"
	"github.com/jiva-studio/shruti/analytics/internal/config"
	"github.com/jiva-studio/shruti/analytics/internal/db"
	"github.com/jiva-studio/shruti/analytics/internal/handler"
	logpkg "github.com/jiva-studio/shruti/analytics/internal/logging"

	// Imported for the init() side effects that register the built-in reports.
	"github.com/jiva-studio/shruti/analytics/internal/reports"
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
		os.Exit(runServe())
	default:
		slog.Error("unknown subcommand", "cmd", cmd)
		os.Exit(2)
	}
}

func runServe() int {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("shruti-analytics", cfg.Env, cfg.ServiceVersion)

	if err := reports.Validate(); err != nil {
		slog.Error("reports_registry_invalid", "err", err.Error())
		return 2
	}

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	pool, err := db.Connect(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()

	// Catalog totals come from the CDN-published catalog SQLite. Warm the cache
	// in the background so the first library_totals request is fast; a failure
	// here is non-fatal (the report retries on demand).
	catalogProvider := catalog.New(cfg.MediaBaseURL)
	go func() {
		warmCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := catalogProvider.Totals(warmCtx); err != nil {
			slog.WarnContext(warmCtx, "catalog_warm_failed", "err", err.Error())
		} else {
			slog.Info("catalog_warmed")
		}
	}()

	root := handler.NewRouter(handler.RouterDeps{
		Pool:        pool,
		Catalog:     catalogProvider,
		Cache:       cache.New(),
		FallbackTTL: cfg.CacheTTL,
	})

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
		return 1
	}
	slog.Info("shutdown_done")
	return 0
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe for
// the FROM-scratch image (no shell/curl inside).
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8086"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/healthz", nil)
	if err != nil {
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
