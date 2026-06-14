// Command denoiser-mcp is a thin MCP wrapper around denoiser-service.
// It runs locally (stdio, spawned by the agent) and points at a remote
// denoiser-service. It also holds the S3 upload credentials, swappable at
// runtime via set_s3_config, and injects them into every job request.
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

	"github.com/akdasa-studios/lectorium/modules/tools/denoiser-mcp/internal/client"
	"github.com/akdasa-studios/lectorium/modules/tools/denoiser-mcp/internal/tools"
)

// dynamicProvider implements tools.Provider with a swappable upstream URL and
// S3 config. In-flight tool calls hold the snapshot they captured; new calls
// observe each swap immediately.
type dynamicProvider struct {
	client atomic.Pointer[client.Client]
	s3cfg  atomic.Pointer[client.S3Dest]
}

func newDynamicProvider(initialURL string, initialS3 client.S3Dest) *dynamicProvider {
	p := &dynamicProvider{}
	p.client.Store(client.New(initialURL))
	cfg := initialS3
	p.s3cfg.Store(&cfg)
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

func (p *dynamicProvider) S3Config() client.S3Dest { return *p.s3cfg.Load() }

func (p *dynamicProvider) SetS3Config(cfg client.S3Dest) error {
	if cfg.Bucket == "" {
		return errors.New("bucket required")
	}
	if cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return errors.New("access_key_id and secret_access_key required")
	}
	p.s3cfg.Store(&cfg)
	return nil
}

const (
	streamableHTTPPath = "/mcp"
	ssePath            = "/sse"
)

func main() {
	addr := flag.String("addr", "0.0.0.0:8092", "HTTP listen address (ignored when -stdio is set)")
	serviceURL := flag.String("service-url", "http://localhost:8091", "denoiser-service base URL")
	pollFast := flag.Duration("poll-interval-fast", 2*time.Second, "poll interval for the first 60s of a wait")
	pollSlow := flag.Duration("poll-interval-slow", 5*time.Second, "poll interval after the fast window")
	pollFastFor := flag.Duration("poll-fast-window", 60*time.Second, "fast-poll window length")
	maxTimeout := flag.Duration("max-timeout", 3600*time.Second, "upper bound on denoise_wait timeout_s")
	heartbeat := flag.Duration("heartbeat-interval", 15*time.Second, "MCP keepalive heartbeat for streamable HTTP")
	token := flag.String("token", "", "optional bearer token; empty disables auth (HTTP mode only)")
	stdio := flag.Bool("stdio", false, "serve MCP over stdin/stdout instead of HTTP")
	flag.Parse()

	// Optional bootstrap of S3 config from env (so a deployment can preload it).
	initialS3 := client.S3Dest{
		Bucket:          os.Getenv("DENOISER_S3_BUCKET"),
		AccessKeyID:     os.Getenv("DENOISER_S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("DENOISER_S3_SECRET_ACCESS_KEY"),
		Region:          os.Getenv("DENOISER_S3_REGION"),
		EndpointURL:     os.Getenv("DENOISER_S3_ENDPOINT_URL"),
		ACL:             os.Getenv("DENOISER_S3_ACL"),
	}
	provider := newDynamicProvider(*serviceURL, initialS3)

	mcp := server.NewMCPServer("denoiser-mcp", "0.1.0",
		server.WithToolCapabilities(true),
	)
	tools.RegisterAll(mcp, provider, tools.Config{
		PollFast:    *pollFast,
		PollSlow:    *pollSlow,
		PollFastFor: *pollFastFor,
		MaxTimeout:  *maxTimeout,
	})

	if *stdio {
		log.SetOutput(os.Stderr)
		log.Printf("denoiser-mcp stdio mode (service=%s)", *serviceURL)
		if err := server.ServeStdio(mcp); err != nil {
			log.Fatalf("stdio: %v", err)
		}
		return
	}

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

	log.Printf("denoiser-mcp listening on %s (service=%s, streamable=%s, sse=%s)",
		*addr, *serviceURL, streamableHTTPPath, ssePath)
	if *token != "" {
		log.Printf("bearer-token auth enabled")
	}
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("denoiser-mcp stopped cleanly")
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
	deadline := time.Now().Add(30 * time.Second)
	for {
		check()
		if ok.Load() || time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
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
		if !strings.EqualFold(r.Header.Get("Authorization"), expected) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
