// Lectorium share-video: HTTP API + queue worker in one process.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/akdasa-studios/lectorium-share-video/internal/config"
	"github.com/akdasa-studios/lectorium-share-video/internal/db"
	"github.com/akdasa-studios/lectorium-share-video/internal/httpx"
	"github.com/akdasa-studios/lectorium-share-video/internal/logx"
	"github.com/akdasa-studios/lectorium-share-video/internal/pipeline"
	"github.com/akdasa-studios/lectorium-share-video/internal/pipeline/reel"
	"github.com/akdasa-studios/lectorium-share-video/internal/pipeline/transcript"
	"github.com/akdasa-studios/lectorium-share-video/internal/storage"
	"github.com/akdasa-studios/lectorium-share-video/internal/worker"
)

func main() {
	bootLog := logx.New("info", "lectorium-share-video", "dev", "dev")
	cfg, err := config.Load()
	if err != nil {
		bootLog.Error("config_load_failed", "err", err.Error())
		os.Exit(1)
	}
	log := logx.New(cfg.LogLevel, "lectorium-share-video", cfg.Env, cfg.ServiceVersion)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Database.
	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("db_init_failed", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()
	if err := db.AssertSchemaReady(ctx, pool); err != nil {
		log.Error("schema_not_migrated", "err", err.Error())
		os.Exit(1)
	}

	// Redis (daily quota counters).
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Error("redis_url_invalid", "err", err.Error())
		os.Exit(1)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Error("redis_ping_failed", "err", err.Error())
		os.Exit(1)
	}

	// S3.
	store, err := storage.New(ctx, cfg.Bucket, cfg.AWSRegion, cfg.S3EndpointURL, cfg.OutputPublicBase)
	if err != nil {
		log.Error("s3_init_failed", "err", err.Error())
		os.Exit(1)
	}

	// Transcriber dispatch.
	tx, err := transcript.New(cfg.Transcriber, transcript.Deps{
		S3:              store.API,
		S3Presigner:     store.Presigner,
		Bucket:          cfg.Bucket,
		ScratchPrefix:   cfg.TranscribeScratch,
		StorageEndpoint: cfg.S3EndpointURL,
		OpenAIKey:       cfg.OpenAIAPIKey,
		SpeechKitKey:    cfg.SpeechKitAPIKey,
	})
	if err != nil {
		log.Error("transcriber_init_failed", "err", err.Error())
		os.Exit(1)
	}

	// Locate bundled assets. Render-image is built with WORKDIR=/app
	// and `COPY assets /app/assets`, so the path is relative to cwd.
	assetsDir := "assets"
	if _, err := os.Stat(assetsDir); errors.Is(err, os.ErrNotExist) {
		// Useful when running outside Docker — fall back to module-rel.
		if exe, err := os.Executable(); err == nil {
			assetsDir = filepath.Join(filepath.Dir(exe), "assets")
		}
	}
	fonts := reel.NewFontLoader(filepath.Join(assetsDir, "fonts", "NotoSans-Bold.ttf"))
	logoPath := filepath.Join(assetsDir, "logo.mp4")
	iconPath := filepath.Join(assetsDir, "icon.png")

	renderer := &pipeline.Renderer{
		S3:                store.API,
		Transcriber:       tx,
		Frames:            &reel.Renderer{Fonts: fonts, IconPNG: iconPath, Opts: reel.Options{SlideWidth: cfg.SlideWidth, SlideHeight: cfg.SlideHeight, FontSize: cfg.FontSize}},
		Composer:          reel.Composer{FFmpegBin: cfg.FfmpegBin},
		FFmpegBin:         cfg.FfmpegBin,
		FFprobeBin:        cfg.FfprobeBin,
		Bucket:            cfg.Bucket,
		BackgroundsPrefix: cfg.BackgroundsPrefix,
		OutputPrefix:      cfg.OutputPrefix,
		OutputPublicBase:  cfg.OutputPublicBase,
		Region:            cfg.AWSRegion,
		LogoPath:          logoPath,
		TitleIconPath:     iconPath,
	}

	// HTTP layer. Single-key verifier — multi-kid dir scanning was
	// dropped with the #728 single-region collapse (a stale
	// `<retired-kid>.pub.pem` left on disk after a redeploy would
	// otherwise still verify forged tokens).
	verifier := httpx.NewJWTVerifier(cfg.JWTPublicKeyPath)
	srvHandlers := &httpx.Server{
		Pool:             pool,
		Redis:            rdb,
		AnonPerDay:       cfg.AnonPerDay,
		SignedInPerDay:   cfg.SignedInPerDay,
		OutputPrefix:     cfg.OutputPrefix,
		OutputPublicBase: cfg.OutputPublicBase,
		Bucket:           cfg.Bucket,
		AWSRegion:        cfg.AWSRegion,
	}
	root := httpx.Recoverer(httpx.RequestMiddleware(log)(srvHandlers.Router(verifier)))
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	// Worker loop.
	w := worker.New(pool, renderer, cfg.TempRoot, log)
	w.Start(ctx)

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
	if err := w.Stop(shutdownCtx); err != nil {
		log.Error("worker_stop_failed", "err", err.Error())
	}
	log.Info("shutdown_done")
}
