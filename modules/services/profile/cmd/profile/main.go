// Lectorium profile service — device<->server sync substrate.
//
// Single Go binary with two subcommands:
//
//	profile serve            — start the HTTP server (default if no subcommand)
//	profile migrate          — apply embedded migrations once, then exit
//	profile healthz          — self-call /healthz over localhost; exit 0/1
//	                           (Docker HEALTHCHECK on the FROM-scratch image)
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

	"github.com/jiva-studio/lectorium/profile/internal/config"
	"github.com/jiva-studio/lectorium/profile/internal/events"
	"github.com/jiva-studio/lectorium/profile/internal/handler"
	"github.com/jiva-studio/lectorium/profile/internal/hlc"
	"github.com/jiva-studio/lectorium/profile/internal/jwt"
	logpkg "github.com/jiva-studio/lectorium/profile/internal/logging"
	"github.com/jiva-studio/lectorium/profile/internal/pending"
	"github.com/jiva-studio/lectorium/profile/internal/service"
	"github.com/jiva-studio/lectorium/profile/internal/store"
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
	logpkg.Setup("lectorium-profile", cfg.Env, cfg.ServiceVersion)

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
	logpkg.Setup("lectorium-profile", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	pool, err := store.Connect(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()

	// Apply embedded migrations on boot. Migrate holds a session advisory lock
	// and is idempotent, so it is safe to run on every start and across
	// concurrent replicas — the service is self-contained and needs no separate
	// one-shot migrate container. `profile migrate` stays available for manual
	// ops. SchemaReady is a final guard against a partial apply.
	if err := store.Migrate(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "migrate_failed", "err", err.Error())
		os.Exit(1)
	}
	if err := store.SchemaReady(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "schema_not_ready", "err", err.Error())
		os.Exit(1)
	}

	verifier, err := jwt.NewVerifierFromFile(cfg.JWTPublicKeyPath)
	if err != nil {
		slog.ErrorContext(bootCtx, "jwt_verifier_init_failed", "err", err.Error())
		os.Exit(1)
	}

	svc := &service.Service{
		Pool:         pool,
		Changes:      &store.ChangesRepo{Pool: pool},
		Cursors:      &store.CursorRepo{Pool: pool},
		Maint:        &store.MaintenanceRepo{Pool: pool},
		PullMaxLimit: cfg.PullMaxLimit,
		HLC:          hlc.NewClock(),
	}

	// Personal Library server-authored ingest (track.events → library_items via
	// svc.ApplyServerChange). Wired but INERT until the streams broker lands —
	// see events.Consumer and #1224. Constructed here so the write path it drives
	// is exercised end-to-end the moment the broker is connected.
	_ = &events.Consumer{Applier: svc}

	root := handler.NewRouter(handler.RouterDeps{
		Svc:        svc,
		Verifier:   verifier,
		Pool:       pool,
		PurgeToken: cfg.InternalAPIToken,
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Corpus-review producer: keep the pending.db artifact on S3 fresh so the
	// offline admin MCP can browse user-generated tracks. Disabled cleanly
	// (logged warning) when S3 config is absent, so local/dev still boots.
	prodCtx, prodCancel := context.WithCancel(context.Background())
	defer prodCancel()
	if producer, perr := pending.NewProducer(prodCtx, pool, cfg.Pending); perr != nil {
		slog.ErrorContext(bootCtx, "pending_producer_init_failed", "err", perr.Error())
		os.Exit(1)
	} else if producer != nil {
		slog.Info("pending_producer_starting", "key", cfg.Pending.Key, "interval", cfg.Pending.Interval.String())
		go producer.Start(prodCtx)
	} else {
		slog.Warn("pending_producer_disabled", "reason", "PENDING_S3_BUCKET unset")
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
	prodCancel() // stop the pending producer loop before draining HTTP

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("shutdown_done")
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe for
// the FROM-scratch image (no shell/curl inside).
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8085"
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
