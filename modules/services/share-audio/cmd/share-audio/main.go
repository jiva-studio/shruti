// Lectorium share-audio. HTTP service that cuts an MP3 slice out of an
// S3-stored source and uploads the excerpt back. Same wire contract as
// the FastAPI service it replaces.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/akdasa-studios/lectorium-share-audio/internal/config"
	"github.com/akdasa-studios/lectorium-share-audio/internal/httpx"
	"github.com/akdasa-studios/lectorium-share-audio/internal/logx"
	"github.com/akdasa-studios/lectorium-share-audio/internal/pipeline"
	"github.com/akdasa-studios/lectorium-share-audio/internal/storage"
)

func main() {
	bootLog := logx.New("info", "lectorium-share-audio", "dev", "dev")

	cfg, err := config.Load()
	if err != nil {
		bootLog.Error("config_load_failed", "err", err.Error())
		os.Exit(1)
	}
	log := logx.New(cfg.LogLevel, "lectorium-share-audio", cfg.Env, cfg.ServiceVersion)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	var store storage.Store
	if cfg.StorageBackend == "bunny" {
		store = storage.NewBunny(cfg.StorageZone, cfg.StorageKey, cfg.StorageEndpoint, cfg.ExcerptsPublicBase)
		log.Info("storage_backend", "backend", "bunny", "zone", cfg.StorageZone)
	} else {
		s3c, err := storage.New(ctx, cfg.Bucket, cfg.AWSRegion, cfg.S3EndpointURL, cfg.ExcerptsPublicBase)
		if err != nil {
			log.Error("s3_init_failed", "err", err.Error())
			os.Exit(1)
		}
		store = s3c
		log.Info("storage_backend", "backend", "s3", "endpoint", cfg.S3EndpointURL)
	}

	// Worker timeout caps a single background cut. The whole flow
	// (download a multi-hundred-MB source from S3, ffmpeg stream-copy
	// trim, upload a small excerpt) is dominated by the download; 5
	// minutes is well above anything we've seen in prod and well below
	// the point where a stuck goroutine starts leaking memory.
	dispatcher := httpx.NewDispatcher(5*time.Minute, log)

	srvHandlers := &httpx.Server{
		Cutter: pipeline.Cutter{
			Storage:         store,
			FFmpeg:          pipeline.FromFFmpegBin(cfg.FfmpegBin),
			Bucket:          cfg.Bucket,
			Prefix:          cfg.ExcerptsPrefix,
			SourceKeyPrefix: cfg.SourceKeyPrefix,
			MaxExcerptMs:    cfg.MaxExcerptMs,
		},
		Dispatcher: dispatcher,
	}

	// Middleware chain (outer-most first): recoverer → request-logger →
	// CORS+router. RequestMiddleware injects the per-request slog child
	// into context for handler use.
	root := httpx.Recoverer(httpx.RequestMiddleware(log)(srvHandlers.Router()))

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		log.Info("server_listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server_failed", "err", err.Error())
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutdown_start", "signal", ctx.Err().Error())
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("server_shutdown_failed", "err", err.Error())
	}
	log.Info("shutdown_done")
}
