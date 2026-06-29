// Command transcriber-mcp is a thin MCP wrapper around transcriber-service.
// See ../../README.md for the full picture.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/transcriber-mcp/internal/client"
	"github.com/jiva-studio/shruti/modules/tools/transcriber-mcp/internal/tools"
)

// dynamicProvider implements tools.Provider with a swappable upstream URL and
// save directory. In-flight tool calls hold the snapshot they captured via
// Client()/SaveDir(), so they keep working against the previous values until
// they finish; new calls observe each swap immediately.
type dynamicProvider struct {
	client  atomic.Pointer[client.Client]
	saveDir atomic.Pointer[string]
}

func newDynamicProvider(initialURL, initialSaveDir string) *dynamicProvider {
	p := &dynamicProvider{}
	p.client.Store(client.New(initialURL))
	dir := initialSaveDir
	p.saveDir.Store(&dir)
	return p
}

func (p *dynamicProvider) Client() tools.JobClient { return p.client.Load() }
func (p *dynamicProvider) URL() string             { return p.client.Load().BaseURL }

func (p *dynamicProvider) SetURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return errors.New("empty URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("URL must be http:// or https://")
	}
	if u.Host == "" {
		return errors.New("URL must include a host")
	}
	p.client.Store(client.New(raw))
	return nil
}

func (p *dynamicProvider) SaveDir() string { return *p.saveDir.Load() }

func (p *dynamicProvider) SetSaveDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("empty save dir")
	}
	p.saveDir.Store(&dir)
	return nil
}

const (
	streamableHTTPPath = "/mcp"
	ssePath            = "/sse"
)

func main() {
	addr := flag.String("addr", "0.0.0.0:8090", "HTTP listen address (ignored when -stdio is set)")
	serviceURL := flag.String("service-url", "http://localhost:8080", "transcriber-service base URL")
	pollFast := flag.Duration("poll-interval-fast", 2*time.Second, "poll interval for the first 60s of a wait")
	pollSlow := flag.Duration("poll-interval-slow", 5*time.Second, "poll interval after the fast window")
	pollFastFor := flag.Duration("poll-fast-window", 60*time.Second, "fast-poll window length")
	maxTimeout := flag.Duration("max-timeout", 3600*time.Second, "upper bound on transcribe_wait timeout_s")
	heartbeat := flag.Duration("heartbeat-interval", 15*time.Second, "MCP keepalive heartbeat for streamable HTTP")
	token := flag.String("token", "", "optional bearer token; empty disables auth (HTTP mode only)")
	stdio := flag.Bool("stdio", false, "serve MCP over stdin/stdout instead of HTTP — for clients like Claude Code that spawn the binary directly")
	saveDir := flag.String("save-dir", "", "default destination directory for save_transcript (default ~/.transcriber/transcripts)")
	flag.Parse()

	resolvedSaveDir := *saveDir
	if resolvedSaveDir == "" {
		resolvedSaveDir = tools.DefaultSaveDir()
	}
	provider := newDynamicProvider(*serviceURL, resolvedSaveDir)

	// Build the MCP server skeleton and register tools.
	mcp := server.NewMCPServer("transcriber-mcp", "0.1.0",
		server.WithToolCapabilities(true),
	)
	tools.RegisterAll(mcp, provider, tools.Config{
		PollFast:    *pollFast,
		PollSlow:    *pollSlow,
		PollFastFor: *pollFastFor,
		MaxTimeout:  *maxTimeout,
	})

	if *stdio {
		// Logs MUST go to stderr in stdio mode — stdout is the JSON-RPC channel.
		log.SetOutput(os.Stderr)
		log.Printf("transcriber-mcp stdio mode (service=%s)", *serviceURL)
		if err := server.ServeStdio(mcp); err != nil {
			log.Fatalf("stdio: %v", err)
		}
		return
	}

	// Two transports on one port:
	streamable := server.NewStreamableHTTPServer(mcp,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithHeartbeatInterval(*heartbeat),
		server.WithStateLess(true),
	)
	sse := server.NewSSEServer(mcp,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
		server.WithKeepAliveInterval(*heartbeat),
	)

	upstreamOK := &atomic.Bool{}
	rootCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go monitorUpstream(rootCtx, provider, upstreamOK)

	mux := http.NewServeMux()
	mux.Handle(streamableHTTPPath, withAuth(*token, streamable))
	mux.Handle(streamableHTTPPath+"/", withAuth(*token, streamable))
	mux.Handle(ssePath, withAuth(*token, sse))
	mux.Handle("/message", withAuth(*token, sse))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":          true,
			"upstream_ok": upstreamOK.Load(),
			"service_url": provider.URL(),
		})
	})

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		// Long-poll friendly: no idle/read/write deadlines on the connection.
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("shutdown: stopping HTTP server")
		ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = httpServer.Shutdown(ctx)
		cancel()
	}()

	log.Printf("transcriber-mcp listening on %s (service=%s, streamable=%s, sse=%s)",
		*addr, *serviceURL, streamableHTTPPath, ssePath)
	if *token != "" {
		log.Printf("bearer-token auth enabled")
	}
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("transcriber-mcp stopped cleanly")
}

func monitorUpstream(ctx context.Context, p *dynamicProvider, ok *atomic.Bool) {
	check := func() {
		c := p.client.Load()
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_, err := c.GetHealth(ctx)
		ok.Store(err == nil)
		if err != nil {
			log.Printf("upstream %s unreachable: %v", c.BaseURL, err)
		}
	}

	// Fast initial probes for the first 30s, then slow steady-state.
	deadline := time.Now().Add(30 * time.Second)
	for {
		check()
		if ok.Load() {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
	if ok.Load() {
		log.Printf("upstream %s reachable", p.URL())
	} else {
		log.Printf("upstream %s still unreachable after 30s; continuing anyway", p.URL())
	}

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func withAuth(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	expected := "Bearer " + token
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if !strings.EqualFold(got, expected) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
