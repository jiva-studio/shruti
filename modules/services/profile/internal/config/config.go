// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Port is the single public+internal HTTP port. Per the design doc the
	// service listens on :8085; /profile/sync/* is routed by the edge and
	// /internal/purge is reachable container-to-container on the same port
	// (the edge simply never forwards /internal/*).
	Port string
	// DatabaseURL points at profile's OWN Postgres — the service knows only
	// its own database, never the shared shruti DB.
	DatabaseURL string
	// JWTPublicKeyPath is the shared RS256 public key (public.pem) used to
	// verify the aud="chat" access token both mobile and web clients hold.
	JWTPublicKeyPath string
	// Env tags log lines. "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime; surfaces in every log line.
	ServiceVersion string
	// PullMaxLimit is the hard cap the server clamps pull.limit to, so a
	// client cannot demand an unbounded page.
	PullMaxLimit int
	// InternalAPIToken optionally guards POST /internal/purge with an
	// X-Internal-Token shared secret (defense-in-depth on top of the
	// network-only routing). Empty = network isolation is the only guard,
	// matching the design doc's "no JWT" purge contract.
	InternalAPIToken string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:             env("PORT", "8085"),
		DatabaseURL:      env("DATABASE_URL", ""),
		JWTPublicKeyPath: env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),
		Env:              env("ENV", "dev"),
		ServiceVersion:   env("SERVICE_VERSION", "dev"),
		PullMaxLimit:     envInt("PULL_MAX_LIMIT", 500),
		InternalAPIToken: os.Getenv("INTERNAL_API_TOKEN"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.PullMaxLimit <= 0 {
		cfg.PullMaxLimit = 500
	}
	return cfg, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
