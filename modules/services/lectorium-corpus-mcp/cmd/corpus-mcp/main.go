// lectorium-corpus-mcp — public, read-only MCP over the Lectorium corpus
// (scripture verses + commentaries + lecture transcripts). Semantic `search`
// runs on Postgres/pgvector (absorbed from search-mcp); structured verse /
// document / track reads run on two published SQLite artifacts (library.db,
// current.db) that the service self-bootstraps from the Bunny CDN.
//
// Transport: streamable-HTTP /mcp + SSE /sse, stateless. Binds 0.0.0.0:<port>
// from CORPUS_MCP_ADDR (default 8087). /healthz reports the build SHA;
// -healthcheck self-probes it for the scratch-image HEALTHCHECK.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/config"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/embed"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/library"
	mcpsrv "github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/mcp"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/search"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/sqlitedb"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/store"
)

// Build stamps injected by CI (-ldflags), surfaced on /healthz + serverInfo.
var (
	buildSHA  = "dev"
	buildTime = "dev"
)

func main() {
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

	// ── SQLite artifacts: self-bootstrap from Bunny (if MEDIA_BASE_URL set),
	//    else use the on-disk files as-is (local dev against lake artifacts).
	var bootstrap *sqlitedb.Bootstrap
	if cfg.MediaBaseURL != "" {
		bootstrap = sqlitedb.NewBootstrap(cfg.MediaBaseURL, cfg.LibraryDBPath, cfg.CatalogDBPath, nil, nil)
		if !fileExists(cfg.CatalogDBPath) || !fileExists(cfg.LibraryDBPath) {
			log.Printf("bootstrap: fetching SQLite artifacts from %s", cfg.MediaBaseURL)
			if err := bootstrap.EnsureBoot(ctx); err != nil {
				log.Fatalf("bootstrap: %v", err)
			}
		}
	} else {
		if !fileExists(cfg.CatalogDBPath) || !fileExists(cfg.LibraryDBPath) {
			log.Fatalf("no MEDIA_BASE_URL and missing SQLite files (%s / %s)", cfg.CatalogDBPath, cfg.LibraryDBPath)
		}
	}

	catHandle, err := sqlitedb.NewHandle(cfg.CatalogDBPath)
	if err != nil {
		log.Fatalf("open catalog db: %v", err)
	}
	defer catHandle.Close()
	libHandle, err := sqlitedb.NewHandle(cfg.LibraryDBPath)
	if err != nil {
		log.Fatalf("open library db: %v", err)
	}
	defer libHandle.Close()

	if bootstrap != nil {
		bootstrap.SetHandles(libHandle, catHandle)
		go bootstrap.Run(ctx, cfg.RefreshInterval)
	}

	// ── Postgres/pgvector + embedder for search / transcript_window (optional).
	var searchRepo *search.Repo
	var embedder *embed.Client
	if cfg.DatabaseURL != "" {
		pool, perr := store.Connect(ctx, cfg.DatabaseURL)
		if perr != nil {
			log.Printf("WARN postgres unavailable, search/transcript_window disabled: %v", perr)
		} else {
			defer pool.Close()
			searchRepo = search.NewRepo(pool, cfg)
			if cfg.EmbedConfigured() {
				embedder = embed.New(cfg)
			} else {
				log.Printf("WARN embedding not configured, `search` disabled (transcript_window still works)")
			}
		}
	} else {
		log.Printf("WARN DATABASE_URL empty, search/transcript_window disabled")
	}

	deps := &mcpsrv.Deps{
		Cfg:     cfg,
		Search:  searchRepo,
		Embed:   embedder,
		Catalog: catalog.New(catHandle),
		Library: library.New(libHandle),
	}

	srv := mcpsrv.New(buildSHA)
	mcpsrv.RegisterTools(srv, deps)

	// Warm the search path in the background so the FIRST real query after a
	// deploy doesn't eat the cold-start cost (pgxpool spin-up + paging the HNSW
	// index into Postgres cache + the initial embedding TLS handshake) — we saw
	// ~16s on a cold first hit. Async: never blocks startup or /healthz.
	if searchRepo != nil && embedder != nil {
		go func() {
			t := time.Now()
			vec, err := embedder.Query(context.Background(), "krishna")
			if err != nil {
				log.Printf("WARN warmup embed failed: %v", err)
				return
			}
			if _, _, err := searchRepo.Hybrid(context.Background(), "krishna", vec, nil, "", 1, 0.3, nil); err != nil {
				log.Printf("WARN warmup search failed: %v", err)
				return
			}
			log.Printf("search warmup done in %s (pool + HNSW + embed primed)", time.Since(t).Round(time.Millisecond))
		}()
	}

	const streamableHTTPPath = "/mcp"
	const ssePath = "/sse"
	streamable := server.NewStreamableHTTPServer(srv,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithStateLess(true),
		server.WithHTTPContextFunc(mcpsrv.InjectClientHash),
	)
	sse := server.NewSSEServer(srv,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
		server.WithSSEContextFunc(mcpsrv.InjectClientHash),
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
		Handler:           corsMiddleware(mux),
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

	log.Printf("lectorium-corpus-mcp listening on %s (mcp=%s sse=%s search=%t embed=%t)",
		cfg.Addr, streamableHTTPPath, ssePath, searchRepo != nil, embedder != nil)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("lectorium-corpus-mcp stopped cleanly")
}

// corsMiddleware sets permissive CORS so browser-based MCP clients (e.g. a
// claude.ai custom connector) can connect. Read-only public data => `*` is OK.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID")
		h.Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func fileExists(p string) bool {
	if p == "" {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

func runHealthcheck() {
	addr := os.Getenv("CORPUS_MCP_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8087"
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
