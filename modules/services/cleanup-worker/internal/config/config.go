// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	// DatabaseURL is the postgres DSN. Same DB the auth/chat services use;
	// no separate role today (see PR #607's migration note on grants).
	DatabaseURL string

	// SweepInterval drives the periodic safety-net poll over app.outbox.
	// LISTEN/NOTIFY is the fast path; the sweep picks up anything missed
	// during a connection drop or a planned restart.
	SweepInterval time.Duration

	// HealthPort is where /healthz binds. Small HTTP server only — keep
	// it off the well-known service ports (auth=8081, share-audio=8082,
	// share-video=8083).
	HealthPort string

	// Env / SERVICE_VERSION mirror the auth service convention so log
	// pipelines (Datadog) tag every line consistently across the stack.
	Env            string
	ServiceVersion string
}

func Load() (*Config, error) {
	cfg := &Config{
		DatabaseURL:    env("DATABASE_URL", ""),
		HealthPort:     env("PORT", "8090"),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	sweep := env("CLEANUP_SWEEP_INTERVAL", "5m")
	d, err := time.ParseDuration(sweep)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_SWEEP_INTERVAL: %w", err)
	}
	if d <= 0 {
		return nil, fmt.Errorf("CLEANUP_SWEEP_INTERVAL must be > 0, got %s", sweep)
	}
	cfg.SweepInterval = d

	return cfg, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
