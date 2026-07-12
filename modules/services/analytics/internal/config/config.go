// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	// Port is the HTTP port. The service is public-read (behind the edge),
	// no internal-only surface. Defaults to :8086.
	Port string
	// DatabaseURL points at the PROFILE service's Postgres — analytics reads
	// profile.listening_sessions read-only to compute reports. It owns no
	// schema and runs no migrations of its own.
	DatabaseURL string
	// CacheTTL is how long a computed report is served from memory before it
	// is recomputed. Reports over a period barely change minute-to-minute, so
	// a short TTL shields the DB from a burst of homepage loads.
	CacheTTL time.Duration
	// MaxRangeDays caps the width of a date-range report so a caller can't
	// demand an unbounded scan / response.
	MaxRangeDays int
	// MediaBaseURL is the Bunny-CDN pull-zone base that publishes the catalog
	// SQLite (/public/config.json manifest + /public/db/shruti.{v}.db). The
	// library_totals report self-fetches from it, same as corpus-mcp / chat.
	MediaBaseURL string
	// Env tags log lines. "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime; surfaces in every log line.
	ServiceVersion string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:           env("PORT", "8086"),
		DatabaseURL:    env("DATABASE_URL", ""),
		CacheTTL:       envDuration("CACHE_TTL", 60*time.Second),
		MaxRangeDays:   envInt("MAX_RANGE_DAYS", 400),
		MediaBaseURL:   env("MEDIA_BASE_URL", "https://cdn.shruti.local"),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.MaxRangeDays <= 0 {
		cfg.MaxRangeDays = 400
	}
	if cfg.CacheTTL < 0 {
		cfg.CacheTTL = 0
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

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
