// shruti-search — read-only MCP server over the prod pgvector corpus.
//
// Exposes search / search_get / search_window so a curator can find the
// chunks (library item_id or lecture track_id@start-end) that back an
// attribution, then feed those ids to shruti-mcp's library.attribution.*.
//
// Runs on the prod origin host inside the `shruti` docker network (so it
// can reach postgres:5432). Compose publishes its port only on the host's
// tailscale IP; the binary itself binds 0.0.0.0 inside the container.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"log"

	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/config"
	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/embed"
	mcpsrv "github.com/jiva-studio/shruti/modules/services/search-mcp/internal/mcp"
	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/store"
)

// Build stamps injected by CI (-ldflags), surfaced on /healthz.
var (
	buildSHA  = "dev"
	buildTime = "dev"
)

func main() {
	// -healthcheck is the container HEALTHCHECK probe: the scratch image has
	// no curl/wget, so the binary probes its own /healthz and exits 0/1.
	healthcheck := flag.Bool("healthcheck", false, "probe local /healthz and exit")
	flag.Parse()
	if *healthcheck {
		runHealthcheck()
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx := context.Background()
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	defer pool.Close()

	embedder := embed.New(cfg)

	srv := mcpsrv.New("shruti-search", "0.1.0")
	mcpsrv.RegisterTools(srv, pool, embedder, cfg)

	const streamableHTTPPath = "/mcp"
	const ssePath = "/sse"
	streamable := server.NewStreamableHTTPServer(srv,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithStateLess(true),
	)
	sse := server.NewSSEServer(srv,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
	)

	mux := http.NewServeMux()
	mux.Handle(streamableHTTPPath, streamable)
	mux.Handle(streamableHTTPPath+"/", streamable)
	mux.Handle(ssePath, sse)
	mux.Handle("/message", sse)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":     "ok",
			"build_sha":  buildSHA,
			"build_time": buildTime,
		})
	})

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("shutdown: stopping HTTP server")
		shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("shruti-search listening on %s (mcp=%s, sse=%s, embed_model=%s, dim=%d, table=%s)",
		cfg.Addr, streamableHTTPPath, ssePath, cfg.EmbedModel, cfg.EmbedDim, cfg.ChunkTable())
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("shruti-search stopped cleanly")
}

// runHealthcheck hits the local /healthz and exits non-zero on failure, so
// the docker HEALTHCHECK works without a shell or curl in the scratch image.
func runHealthcheck() {
	addr := os.Getenv("SEARCH_MCP_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8086"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		log.Printf("healthcheck: %v", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck: status %d", resp.StatusCode)
		os.Exit(1)
	}
}
