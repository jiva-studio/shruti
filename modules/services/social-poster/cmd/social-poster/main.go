// Shruti social-poster. A single service that, on a schedule, selects
// content from the published catalog (daily wisdom or lectures, via dynamic
// filters) and posts it to Telegram / VK / Facebook. Modeled on share-audio.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jiva-studio/shruti-social-poster/internal/catalog"
	"github.com/jiva-studio/shruti-social-poster/internal/config"
	"github.com/jiva-studio/shruti-social-poster/internal/httpx"
	"github.com/jiva-studio/shruti-social-poster/internal/logx"
	"github.com/jiva-studio/shruti-social-poster/internal/runner"
	"github.com/jiva-studio/shruti-social-poster/internal/scheduler"
	"github.com/jiva-studio/shruti-social-poster/internal/state"
)

func main() {
	bootLog := logx.New("info", "shruti-social-poster", "dev", "dev")

	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		configPath = "/etc/social-poster/config.yaml"
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		bootLog.Error("config_load_failed", "err", err.Error())
		os.Exit(1)
	}
	log := logx.New(cfg.Service.LogLevel, "shruti-social-poster", cfg.Service.Env, cfg.Service.ServiceVersion)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	httpc := &http.Client{Timeout: 90 * time.Second}

	// Catalog: build per-region handles and do an initial pull so the first
	// scheduled run has data. A failed initial pull is fatal — better to
	// crash-loop visibly than run blind with no catalog.
	cat := catalog.NewManager(cfg, httpc)
	{
		ictx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		if err := cat.RefreshAll(ictx); err != nil {
			cancel()
			log.Error("initial_catalog_refresh_failed", "err", err.Error())
			os.Exit(1)
		}
		cancel()
	}
	defer cat.Close()

	st, err := state.Open(cfg.State.DBPath)
	if err != nil {
		log.Error("state_open_failed", "err", err.Error())
		os.Exit(1)
	}
	defer st.Close()

	run, err := runner.New(cfg, cat, st, httpc, log)
	if err != nil {
		log.Error("runner_init_failed", "err", err.Error())
		os.Exit(1)
	}

	sched := scheduler.New(cfg, cat, run, log)
	if err := sched.Start(); err != nil {
		log.Error("scheduler_start_failed", "err", err.Error())
		os.Exit(1)
	}
	defer sched.Stop()

	srv := &http.Server{
		Addr:              ":" + cfg.Service.Port,
		Handler:           httpx.RequestMiddleware(log)(httpx.Recoverer((&httpx.Server{Cfg: cfg, Cat: cat, Runner: run, Log: log}).Router())),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("listening", "port", cfg.Service.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http_serve_failed", "err", err.Error())
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting_down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
