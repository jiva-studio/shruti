// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// RemoteRegion is the parsed form of a single REMOTE_REGIONS entry
// (`id=baseurl`). Re-exported as handlers.RemoteRegion via the
// SubscriptionBroadcast wiring in cmd/cleanup-worker/main.go — defined
// here so config tests don't need a handlers import cycle.
type RemoteRegion struct {
	ID      string
	BaseURL string
}

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

	// RetentionInterval drives the periodic retention sweep over processed
	// rows in app.outbox and auth.rc_webhook_events. Default 24h — sweeping
	// more often just wastes a DELETE, the eligible set rotates on a
	// day-or-greater scale.
	RetentionInterval time.Duration

	// RetentionWebhookEventsTTL is how long a processed auth.rc_webhook_events
	// row stays before retention deletes it. Plan: 90d.
	RetentionWebhookEventsTTL time.Duration

	// RetentionOutboxTTL is how long a processed app.outbox row stays.
	// Plan: 30d.
	RetentionOutboxTTL time.Duration

	// InternalSecret is the HMAC key shared with every region's auth
	// service. Used to sign cross-region subscription.broadcast
	// deliveries to /internal/subscription/apply. Empty disables the
	// broadcast handler (single-region deployment); non-empty with no
	// RemoteRegions configured is harmless (the handler still no-ops).
	InternalSecret string

	// RemoteRegions is the parsed REMOTE_REGIONS env (comma-separated
	// `id=baseurl` pairs). The broadcast handler iterates this list on
	// every cross-region event and POSTs each region's
	// /internal/subscription/apply.
	RemoteRegions []RemoteRegion

	// SignedInTTL controls the long-tail cleanup of signed-in users
	// whose newest refresh_token is older than this duration. Sibling
	// of AnonCleanupTTL — same activity proxy (refresh_tokens.created_at),
	// different selection predicate (must have a non-device identity).
	// Zero disables the cron. Default 17520h = ~24 months.
	SignedInTTL time.Duration

	// SignedInTTLInterval drives the signed-in TTL cron ticker.
	SignedInTTLInterval time.Duration

	// SignedInTTLDryRun gates whether the cron actually DELETEs.
	// Default true — the initial deployment runs dry-run for 1-2 weeks
	// so the operator can verify the would-delete log lines look right
	// before flipping to false.
	SignedInTTLDryRun bool
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

	// Retention sweep over processed bookkeeping rows. Defaults match the
	// improvement plan (Tier 2.6); each knob is overridable for tests/dev.
	retInt := env("CLEANUP_RETENTION_INTERVAL", "24h")
	retIntD, err := time.ParseDuration(retInt)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_RETENTION_INTERVAL: %w", err)
	}
	if retIntD <= 0 {
		return nil, fmt.Errorf("CLEANUP_RETENTION_INTERVAL must be > 0, got %s", retInt)
	}
	cfg.RetentionInterval = retIntD

	wTTL := env("CLEANUP_RETENTION_RC_WEBHOOK_TTL", "2160h") // 90d
	wTTLd, err := time.ParseDuration(wTTL)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_RETENTION_RC_WEBHOOK_TTL: %w", err)
	}
	if wTTLd <= 0 {
		return nil, fmt.Errorf("CLEANUP_RETENTION_RC_WEBHOOK_TTL must be > 0, got %s", wTTL)
	}
	cfg.RetentionWebhookEventsTTL = wTTLd

	oTTL := env("CLEANUP_RETENTION_OUTBOX_TTL", "720h") // 30d
	oTTLd, err := time.ParseDuration(oTTL)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_RETENTION_OUTBOX_TTL: %w", err)
	}
	if oTTLd <= 0 {
		return nil, fmt.Errorf("CLEANUP_RETENTION_OUTBOX_TTL must be > 0, got %s", oTTL)
	}
	cfg.RetentionOutboxTTL = oTTLd

	// Cross-region fan-out (PR-2b). SHRUTI_INTERNAL_SECRET signs every
	// broadcast delivery; REMOTE_REGIONS lists the destinations. Both
	// empty = single-region deployment (Cloud Provider today). Half-configured
	// is a misconfiguration: REMOTE_REGIONS without a secret cannot sign
	// requests and would 401 at every destination — fail boot loudly.
	cfg.InternalSecret = env("SHRUTI_INTERNAL_SECRET", "")
	cfg.RemoteRegions = parseRemoteRegions(env("REMOTE_REGIONS", ""))
	if cfg.InternalSecret == "" && len(cfg.RemoteRegions) > 0 {
		return nil, fmt.Errorf("SHRUTI_INTERNAL_SECRET is required when REMOTE_REGIONS is set")
	}

	// Signed-in TTL cron. Same shape as anon: TTL=0 disables, otherwise
	// both knobs must parse. Default 17520h ≈ 24 months matches the plan
	// (2-dead-letter-policy-steady-catmull.md PR-5).
	siTTLStr := env("CLEANUP_SIGNED_IN_TTL", "17520h")
	siTTL, err := time.ParseDuration(siTTLStr)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_SIGNED_IN_TTL: %w", err)
	}
	if siTTL < 0 {
		return nil, fmt.Errorf("CLEANUP_SIGNED_IN_TTL must be >= 0, got %s", siTTLStr)
	}
	cfg.SignedInTTL = siTTL

	siIntStr := env("CLEANUP_SIGNED_IN_INTERVAL", "24h")
	siInt, err := time.ParseDuration(siIntStr)
	if err != nil {
		return nil, fmt.Errorf("CLEANUP_SIGNED_IN_INTERVAL: %w", err)
	}
	if siTTL > 0 && siInt <= 0 {
		return nil, fmt.Errorf("CLEANUP_SIGNED_IN_INTERVAL must be > 0 when CLEANUP_SIGNED_IN_TTL > 0, got %s", siIntStr)
	}
	cfg.SignedInTTLInterval = siInt

	// Dry-run defaults to true on the first deploy so the operator can
	// scan would-delete log lines before letting the cron actually run.
	// Operator flips CLEANUP_SIGNED_IN_DRY_RUN=false after observing
	// stable output for 1-2 weeks.
	cfg.SignedInTTLDryRun = envBool("CLEANUP_SIGNED_IN_DRY_RUN", true)

	return cfg, nil
}

// envBool reads a bool-ish env var. Accepts "true"/"1"/"yes"/"on" as
// true (case-insensitive); "false"/"0"/"no"/"off" as false; anything
// else (or unset) returns def. Lenient parse on purpose — env vars set
// from shell scripts vs docker-compose YAML carry surprising whitespace.
func envBool(k string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	return def
}

// parseRemoteRegions turns `russia=https://auth.russia.shruti.app,
// other=https://...` into a slice of RemoteRegion. Trims whitespace
// around each `id` and `baseurl`; silently skips empty or malformed
// entries (missing `=`) so a trailing comma in the env doesn't fail
// boot.
func parseRemoteRegions(s string) []RemoteRegion {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]RemoteRegion, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		kv := strings.SplitN(p, "=", 2)
		if len(kv) != 2 {
			continue
		}
		id := strings.TrimSpace(kv[0])
		base := strings.TrimSpace(kv[1])
		if id == "" || base == "" {
			continue
		}
		out = append(out, RemoteRegion{ID: id, BaseURL: base})
	}
	return out
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
