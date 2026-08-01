// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the discovery service's runtime configuration.
type Config struct {
	// Port serves health, readiness and the discovery API.
	Port string
	// DatabaseURL points at the service's OWN Postgres, which must have the
	// pgvector extension available.
	DatabaseURL string
	// Env tags log lines. "dev" | "staging" | "prod".
	Env string
	// ServiceVersion is the image tag at runtime.
	ServiceVersion string

	// SchedulerEnabled gates the automatic crawl loop and nothing else. Off by
	// default: starting the service must not make it fetch anything. Explicit
	// single-URL requests always run regardless.
	SchedulerEnabled bool
	// ScheduleInterval is how often the scheduler looks for work.
	ScheduleInterval time.Duration
	// SchedulerPageLimit caps how many pages one scheduled pass over a source
	// will fetch, so an automatic run can never turn into a full sweep.
	SchedulerPageLimit int

	// --- outbound HTTP politeness ---

	// UserAgent identifies us to the sites we read, with a contact URL so an
	// operator can reach a person rather than block a stranger.
	UserAgent string
	// DefaultCrawlDelay is the minimum gap between requests to one host, used
	// when robots.txt states none.
	DefaultCrawlDelay time.Duration
	// RequestTimeout bounds a single outbound request.
	RequestTimeout time.Duration
	// MaxBodyBytes caps a response body we are willing to read.
	MaxBodyBytes int64

	// --- model access, all through OpenRouter ---

	// LLMBaseURL is an OpenAI-compatible endpoint. Empty leaves the normalizer
	// unconfigured: extraction still runs and still stores raw records.
	LLMBaseURL string
	LLMAPIKey  string
	LLMModel   string

	EmbedModel string
	EmbedDim   int
}

// Load reads the environment. It does not require a database, because the
// single-URL dry run needs no database — asking about one URL should not depend
// on the service being deployed.
func Load() *Config {
	cfg := &Config{
		Port:           env("PORT", "8089"),
		DatabaseURL:    env("DATABASE_URL", ""),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),

		SchedulerEnabled:   envBool("DISCOVERY_SCHEDULER_ENABLED", false),
		ScheduleInterval:   envDuration("DISCOVERY_SCHEDULE_INTERVAL", 10*time.Minute),
		SchedulerPageLimit: envInt("DISCOVERY_SCHEDULER_PAGE_LIMIT", 200),

		UserAgent:         env("DISCOVERY_USER_AGENT", "LectoriumDiscovery/1.0 (+https://shruti.app/about)"),
		DefaultCrawlDelay: envDuration("DISCOVERY_CRAWL_DELAY", time.Second),
		RequestTimeout:    envDuration("DISCOVERY_REQUEST_TIMEOUT", 30*time.Second),
		MaxBodyBytes:      int64(envInt("DISCOVERY_MAX_BODY_BYTES", 8<<20)),

		LLMBaseURL: env("DISCOVERY_LLM_BASE_URL", ""),
		LLMAPIKey:  os.Getenv("DISCOVERY_LLM_API_KEY"),
		LLMModel:   env("DISCOVERY_LLM_MODEL", "openai/gpt-4o-mini"),

		EmbedModel: env("DISCOVERY_EMBED_MODEL", "openai/text-embedding-3-small"),
		EmbedDim:   envInt("DISCOVERY_EMBED_DIM", 1536),
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 8 << 20
	}
	return cfg
}

// RequireDatabase is what serve and migrate check; parse does not.
func (c *Config) RequireDatabase() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	return nil
}

// NormalizerReady reports whether the model is configured. When it is not, the
// service still fetches, extracts and stores raw records — it just cannot say
// what any of them mean.
func (c *Config) NormalizerReady() (bool, []string) {
	var missing []string
	if c.LLMBaseURL == "" {
		missing = append(missing, "DISCOVERY_LLM_BASE_URL")
	}
	if c.LLMAPIKey == "" {
		missing = append(missing, "DISCOVERY_LLM_API_KEY")
	}
	return len(missing) == 0, missing
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
