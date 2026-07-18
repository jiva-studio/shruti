// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Port is the HTTP port (health + future admin). The pipeline itself is
	// broker-driven, not request/response.
	Port string
	// DatabaseURL points at the orchestrator's OWN Postgres — the job store is
	// the source of truth; it never touches the shared lectorium DB.
	DatabaseURL string
	// Env tags log lines. "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime; surfaces in every log line.
	ServiceVersion string
	// MaxAttempts caps job retries before a job is dead-lettered (used by the
	// pipeline worker; carried here so it is configurable per environment).
	MaxAttempts int
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:           env("PORT", "8086"),
		DatabaseURL:    env("DATABASE_URL", ""),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
		MaxAttempts:    envInt("MAX_ATTEMPTS", 5),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 5
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
