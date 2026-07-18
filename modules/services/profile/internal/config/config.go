// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
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
	// Pending configures the corpus-review artifact producer (pending.db → S3).
	Pending PendingConfig
}

// PendingConfig configures the background producer that exports user-generated
// (server-owned library_items) tracks into a SQLite `pending.db` on S3, which
// the offline admin MCP fetches to browse + approve them. The producer is
// DISABLED (a clean no-op) when Bucket is empty, so local/dev boots without S3.
type PendingConfig struct {
	// Bucket is the S3 bucket the artifact lands in. Empty disables the
	// producer entirely.
	Bucket string
	// Key is the object key the pending.db is uploaded to.
	Key string
	// Endpoint optionally overrides the S3 endpoint for S3-compatible stores
	// (Yandex Object Storage, MinIO). Empty = default AWS resolution.
	Endpoint string
	// Region is the S3 region (defaults to us-east-1).
	Region string
	// AccessKeyID / SecretAccessKey are optional static credentials. When
	// empty the SDK's default chain (env, instance profile) is used.
	AccessKeyID     string
	SecretAccessKey string
	// ForcePathStyle selects path-style addressing, required by most
	// S3-compatible endpoints.
	ForcePathStyle bool
	// Interval is how often the artifact is regenerated and re-uploaded.
	Interval time.Duration
}

// Enabled reports whether the producer should run.
func (p PendingConfig) Enabled() bool { return p.Bucket != "" }

func Load() (*Config, error) {
	cfg := &Config{
		Port:             env("PORT", "8085"),
		DatabaseURL:      env("DATABASE_URL", ""),
		JWTPublicKeyPath: env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),
		Env:              env("ENV", "dev"),
		ServiceVersion:   env("SERVICE_VERSION", "dev"),
		PullMaxLimit:     envInt("PULL_MAX_LIMIT", 500),
		InternalAPIToken: os.Getenv("INTERNAL_API_TOKEN"),
		Pending: PendingConfig{
			Bucket:          os.Getenv("PENDING_S3_BUCKET"),
			Key:             env("PENDING_S3_KEY", "public/db/pending.db"),
			Endpoint:        os.Getenv("PENDING_S3_ENDPOINT"),
			Region:          env("PENDING_S3_REGION", "us-east-1"),
			AccessKeyID:     os.Getenv("PENDING_S3_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("PENDING_S3_SECRET_ACCESS_KEY"),
			ForcePathStyle:  envBool("PENDING_S3_FORCE_PATH_STYLE", false),
			Interval:        envDuration("PENDING_INTERVAL", 5*time.Minute),
		},
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

func envBool(k string, def bool) bool {
	if v := os.Getenv(k); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}
