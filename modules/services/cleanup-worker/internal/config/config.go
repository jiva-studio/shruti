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

	// AnonCleanupTTL is how long an anonymous (device-only) account may sit
	// idle before the cron deletes it. Activity proxy: the newest
	// auth.refresh_tokens.created_at for the user — older than this means
	// the user hasn't opened the app in TTL. Default 8760h (365 days).
	// Zero disables the cron entirely (handy in tests / dev).
	AnonCleanupTTL time.Duration

	// AnonCleanupInterval drives the cron ticker. The DELETE statement is
	// cheap (partial index on refresh_tokens.user_id) so a once-a-day cadence
	// is plenty; tighter only buys faster expiry, never throughput.
	AnonCleanupInterval time.Duration
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

	// Anonymous-account cleanup cron. TTL=0 disables (cron skipped at boot);
	// otherwise both values must parse and be non-negative. Interval=0 with
	// TTL>0 is rejected — silent "never tick" would be a footgun.
	ttlStr := env("CLEANUP_ANON_TTL", "8760h")
	ttl, err := time.ParseDuration(ttlStr)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_ANON_TTL: %w", err)
	}
	if ttl < 0 {
		return nil, fmt.Errorf("CLEANUP_ANON_TTL must be >= 0, got %s", ttlStr)
	}
	cfg.AnonCleanupTTL = ttl

	intStr := env("CLEANUP_ANON_INTERVAL", "24h")
	interval, err := time.ParseDuration(intStr)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_ANON_INTERVAL: %w", err)
	}
	if ttl > 0 && interval <= 0 {
		return nil, fmt.Errorf("CLEANUP_ANON_INTERVAL must be > 0 when CLEANUP_ANON_TTL > 0, got %s", intStr)
	}
	cfg.AnonCleanupInterval = interval

	return cfg, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
