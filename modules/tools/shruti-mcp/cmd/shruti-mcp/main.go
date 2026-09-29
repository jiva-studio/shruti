// Command shruti-mcp serves the lake and catalog tools over MCP.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/assethashes"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/container"
	osfs "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/fs/os"
	sha256hash "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/hashing/sha256"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "path to YAML config (default: ./shruti-mcp.yaml)")
	doServe := flag.Bool("serve", true, "run the MCP HTTP server (default true)")
	addr := flag.String("addr", "127.0.0.1:8081", "HTTP listen address for MCP transports (streamable + SSE)")
	heartbeat := flag.Duration("heartbeat-interval", 15*time.Second, "MCP keepalive heartbeat for streamable HTTP / SSE")
	workers := flag.Int("workers", 4, "number of file-level pipeline workers")
	transcribeConcurrency := flag.Int("transcribe-concurrency", 2, "max concurrent transcribe calls")
	backfillHashes := flag.Bool("backfill-asset-hashes", false, "hash the published transcripts under <out> into asset_hashes in current.db, then exit")
	flag.Parse()

	path, err := resolveConfigPath(*configPath)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		return fmt.Errorf("config load: %w", err)
	}
	ctx := context.Background()

	if *backfillHashes {
		return backfillAssetHashes(ctx, cfg.Out)
	}
	if !*doServe {
		printConfig(path, cfg)
		return nil
	}
	return serve(ctx, cfg, *addr, *heartbeat, container.Options{
		Workers:               *workers,
		TranscribeConcurrency: *transcribeConcurrency,
	})
}

func serve(ctx context.Context, cfg *config.Config, addr string, heartbeat time.Duration, opts container.Options) (err error) {
	c, err := container.Build(ctx, cfg, opts)
	if err != nil {
		return err
	}

	startProfiler()
	mcpServer := buildMCPHTTPServer(c.Deps, addr, heartbeat)

	// The workers stop at the next stage boundary once poolCtx is cancelled;
	// the stages a run completed stay recorded and resume on the next ingest.
	poolCtx, stopPool := context.WithCancel(ctx)
	defer stopPool()
	c.Pool.Start(poolCtx)

	sigCtx, stopSignals := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("shruti-mcp listening on %s (workers=%d, transcribe-concurrency=%d, streamable=%s, sse=%s)",
			addr, opts.Workers, opts.TranscribeConcurrency, streamableHTTPPath, ssePath)
		if err := mcpServer.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- fmt.Errorf("listen: %w", err)
			return
		}
		serveErr <- nil
	}()

	select {
	case err = <-serveErr:
	case <-sigCtx.Done():
		log.Printf("shutdown: stopping the MCP transports and draining the worker pool")
	}
	err = errors.Join(err, shutdown{
		transports: []func(context.Context) error{mcpServer.sse.Shutdown, mcpServer.streamable.Shutdown},
		http:       mcpServer.http.Shutdown,
		stopPool:   stopPool,
		waitPool:   c.Pool.Wait,
		close:      c.Close,
		httpGrace:  shutdownGrace,
		poolGrace:  shutdownGrace,
	}.run(ctx))
	if err == nil {
		log.Printf("shruti-mcp stopped cleanly")
	}
	return err
}

// startProfiler serves pprof on $SHRUTI_PPROF when it is set. Wall-clock
// time here is mostly waiting, so the block and mutex profiles are the ones
// that say where it went.
func startProfiler() {
	pprofAddr := os.Getenv("SHRUTI_PPROF")
	if pprofAddr == "" {
		return
	}
	runtime.SetBlockProfileRate(1000)
	runtime.SetMutexProfileFraction(10)
	go func() {
		log.Printf("[pprof] listening on %s", pprofAddr)
		srv := &http.Server{Addr: pprofAddr, ReadHeaderTimeout: 10 * time.Second}
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("[pprof] stopped: %v", err)
		}
	}()
}

func backfillAssetHashes(ctx context.Context, out string) (err error) {
	store, err := container.OpenCatalog(ctx, out)
	if err != nil {
		return fmt.Errorf("backfill-asset-hashes: %w", err)
	}
	defer func() { err = errors.Join(err, store.Close()) }()
	res, err := assethashes.UseCase{
		Catalog: store,
		Files:   osfs.New(),
		Hasher:  sha256hash.New(),
		OutDir:  out,
	}.Run(ctx)
	if err != nil {
		return fmt.Errorf("backfill-asset-hashes: %w", err)
	}
	log.Printf("[backfill] asset_hashes: %d transcripts hashed, %d files missing (of %d variants)",
		res.Hashed, res.Missing, res.Variants)
	return nil
}

func printConfig(path string, cfg *config.Config) {
	fmt.Printf("shruti-mcp\n")
	fmt.Printf("  config:           %s\n", path)
	fmt.Printf("  scheme:           %d\n", catalogdb.Scheme)
	fmt.Printf("  in:               %s\n", cfg.In)
	fmt.Printf("  out:              %s\n", cfg.Out)
	fmt.Printf("  db:               %s\n", cfg.DB)
	fmt.Printf("  default_language: %s\n", cfg.DefaultLanguage)
	fmt.Printf("  cdn.read_base_url:%s\n", cfg.CDN.ReadBaseURL)
	fmt.Printf("  ffmpeg:           bin=%s\n", cfg.FFmpeg.Bin)
	fmt.Printf("  s3.bunny.zone:    %s (endpoint=%s)\n", cfg.S3.Bunny.Zone, cfg.S3.Bunny.Endpoint)
	fmt.Printf("  transcribe.default: %s\n", cfg.Transcribe.Default)
	for name, p := range cfg.Transcribe.Providers {
		fmt.Printf("  transcribe[%s]: kind=%s endpoint=%s model=%s\n", name, p.Kind, p.Endpoint, p.Model)
	}
	fmt.Printf("  review:           defaults=%v (chunk=%d overlap=%d retries=%d concurrency=%d hybrid={threshold=%.2f expand=%d})\n",
		cfg.Review.Default, cfg.Review.ChunkSize, cfg.Review.Overlap, cfg.Review.Retries, cfg.Review.Concurrency, cfg.Review.Hybrid.Threshold, cfg.Review.Hybrid.Expand)
	for alias, p := range cfg.Review.Providers {
		fmt.Printf("  review[%s]: model=%s endpoint=%s reasoning=%s api_key=%s\n", alias, p.Model, p.Endpoint, p.Reasoning, maskKey(p.APIKey))
	}
	fmt.Printf("  resolver.default: %s (top_n=%d)\n", cfg.Resolver.Default, cfg.Resolver.CandidatesTopN)
	for alias, p := range cfg.Resolver.Providers {
		fmt.Printf("  resolver[%s]: model=%s endpoint=%s api_key=%s\n", alias, p.Model, p.Endpoint, maskKey(p.APIKey))
	}
	fmt.Printf("  metadata:         model=%s endpoint=%s api_key=%s (max_tokens=%d)\n",
		cfg.Metadata.Model, cfg.Metadata.Endpoint, maskKey(cfg.Metadata.APIKey), cfg.Metadata.MaxTokens)
}

func maskKey(k string) string {
	if k == "" {
		return "<unset>"
	}
	if len(k) <= 8 {
		return "***"
	}
	return k[:4] + "…" + k[len(k)-4:]
}

// resolveConfigPath looks for the YAML config in the working directory: the
// config, and any .env it names, belong with the project rather than $HOME.
func resolveConfigPath(explicit string) (string, error) {
	candidates := []string{"shruti-mcp.yaml", "shruti-mcp.yml"}
	if explicit != "" {
		candidates = []string{explicit}
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return filepath.Abs(c)
		}
	}
	return "", fmt.Errorf("no config found; tried: %v", candidates)
}
