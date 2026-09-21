// Lectorium billing service — crypto (Paymento) checkout → PRO.
//
// Single Go binary. Entry behavior:
//
//	/billing            — start HTTP server (default)
//	/billing healthz    — self-call /billing/healthz over localhost; exit 0/1.
//	                      Used by Docker HEALTHCHECK on the FROM-scratch image.
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

	"github.com/jiva-studio/lectorium/billing/internal/authclient"
	"github.com/jiva-studio/lectorium/billing/internal/config"
	"github.com/jiva-studio/lectorium/billing/internal/driver"
	"github.com/jiva-studio/lectorium/billing/internal/handler"
	"github.com/jiva-studio/lectorium/billing/internal/jwtverify"
	logpkg "github.com/jiva-studio/lectorium/billing/internal/logging"
	"github.com/jiva-studio/lectorium/billing/internal/paymento"
	"github.com/jiva-studio/lectorium/billing/internal/reconcile"
	"github.com/jiva-studio/lectorium/billing/internal/store"
)

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) > 1 && os.Args[1] == "healthz" {
		return selfHealthz()
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("lectorium-billing", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer bootCancel()

	pool, err := store.Connect(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()

	// Migrations come from the central `migrator` container, not this binary.
	if err := store.AssertSchemaReady(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "schema_not_ready", "err", err.Error())
		return 1
	}

	verifier, err := jwtverify.NewVerifierFromFile(cfg.JWTPublicKeyPath)
	if err != nil {
		slog.ErrorContext(bootCtx, "jwt_verifier_init_failed", "err", err.Error())
		return 1
	}

	repo := &store.Repo{Pool: pool}
	pmt := paymento.New(cfg.PaymentoBaseURL, cfg.PaymentoAPIKey)
	authcli := authclient.New(cfg.AuthInternalURL, cfg.InternalAPIToken)
	drv := &driver.Driver{Pool: pool, Repo: repo, Paymento: pmt, Auth: authcli}

	h := &handler.BillingHandler{
		Repo:          repo,
		Verifier:      verifier,
		Paymento:      pmt,
		Driver:        drv,
		PublicBaseURL: cfg.PublicBaseURL,
		HMACSecret:    cfg.PaymentoHMACSecret,
	}
	root := handler.NewRouter(h)

	if !pmt.Configured() {
		slog.Warn("paymento_unconfigured", "reason", "PAYMENTO_API_KEY unset; /billing/checkout returns 503")
	}
	if cfg.PaymentoHMACSecret == "" {
		slog.Warn("webhook_unconfigured", "reason", "PAYMENTO_HMAC_SECRET unset; /webhooks/paymento returns 503")
	}
	if !authcli.Configured() {
		slog.Warn("grant_unconfigured", "reason", "INTERNAL_API_TOKEN unset; grants fail and orders await reconcile")
	}

	// Reconcile worker re-drives stuck orders so a lost IPN or a downstream
	// outage self-heals. Runs regardless of secret state — when Paymento/auth
	// are unconfigured it simply logs failures and retries.
	reconcileCtx, reconcileCancel := context.WithCancel(context.Background())
	defer reconcileCancel()
	worker := &reconcile.Worker{Repo: repo, Driver: drv}
	go func() {
		if err := worker.Run(reconcileCtx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("reconcile_loop_exited", "err", err.Error())
		}
	}()

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

	reconcileCancel()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		return 1
	}
	slog.Info("shutdown_done")
	return 0
}

func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/billing/healthz", nil)
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
