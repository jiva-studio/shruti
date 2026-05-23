// Shruti auth service.
//
// Single Go binary. Entry behavior:
//   /auth                  — start HTTP server (default)
//   /auth healthz          — self-call /auth/healthz over localhost; exit 0/1.
//                            Used by Docker HEALTHCHECK on the FROM-scratch image.
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

	"github.com/jiva-studio/shruti/auth/internal/config"
	"github.com/jiva-studio/shruti/auth/internal/handler"
	"github.com/jiva-studio/shruti/auth/internal/jwt"
	logpkg "github.com/jiva-studio/shruti/auth/internal/logging"
	"github.com/jiva-studio/shruti/auth/internal/providers/apple"
	"github.com/jiva-studio/shruti/auth/internal/providers/google"
	"github.com/jiva-studio/shruti/auth/internal/service"
	"github.com/jiva-studio/shruti/auth/internal/store"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthz":
			os.Exit(selfHealthz())
		case "genkeys":
			os.Exit(genKeys(os.Args[2:]))
		}
	}

	cfg, err := config.Load()
	if err != nil {
		// Logging isn't set up yet — slog default is stderr text. Acceptable
		// for the one config-load error path; everything else logs JSON.
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logpkg.Setup("shruti-auth", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer bootCancel()
	pool, err := store.Connect(bootCtx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(bootCtx, "db_connect_failed", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()

	// Migrations come from the central `migrator` compose service, not
	// from this binary. Just confirm the expected schema is in place;
	// if not, crash with a clear hint instead of spewing pgx errors.
	if err := store.AssertSchemaReady(bootCtx, pool); err != nil {
		slog.ErrorContext(bootCtx, "schema_not_ready", "err", err.Error())
		os.Exit(1)
	}

	signer, err := jwt.NewSignerFromFile(cfg.JWTPrivateKeyPath, cfg.JWTKid)
	if err != nil {
		slog.ErrorContext(bootCtx, "jwt_signer_init_failed", "err", err.Error())
		os.Exit(1)
	}
	verifier, err := jwt.NewVerifierFromFile(cfg.JWTPublicKeyPath)
	if err != nil {
		slog.ErrorContext(bootCtx, "jwt_verifier_init_failed", "err", err.Error())
		os.Exit(1)
	}
	svc := &service.Service{
		Pool:           pool,
		Users:          &store.UserRepo{Pool: pool},
		Identities:     &store.IdentityRepo{Pool: pool},
		RefreshTokens:  &store.RefreshTokenRepo{Pool: pool},
		Signer:         signer,
		Verifier:       verifier,
		GoogleVerifier: google.NewVerifier(cfg.GoogleClientIDs),
		AppleVerifier:  apple.NewVerifier(cfg.AppleBundleIDs),
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler.NewRouter(svc, verifier),
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

// selfHealthz hits /auth/healthz on localhost and returns the appropriate exit
// code. Docker HEALTHCHECK needs to run *inside* the FROM-scratch image, so we
// dogfood our own binary as the probe.
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/auth/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
