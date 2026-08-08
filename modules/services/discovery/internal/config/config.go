// Package config loads runtime configuration from environment variables.
//
// One prefix, everywhere. A setting is LECTORIUM_DISCOVERY_… in the deployment
// file, in compose, and here — rather than one name outside the container and a
// shorter one inside it. That translation cost us twice: a variable that existed
// in the code and in neither of the other two, and a default that disagreed
// between the code and compose while both looked right on their own.
//
// The defaults live here and only here. Compose passes the deployment file
// through and states a default only where it computes something — a password
// into a DSN, one variable standing in for another.
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
	// SchedulerWorkers is how many pages the scheduler may have in flight at
	// once, across every source. It only stops us idling through somebody
	// else's round trip: what bounds the rate is the per-host gap below.
	SchedulerWorkers int
	// PageTimeout bounds one page end to end — fetch, model, embed, write. The
	// individual steps have their own timeouts and they stack: a page could
	// otherwise hold a worker and a database connection for tens of minutes.
	PageTimeout time.Duration
	// DBMaxConns sizes the pool. The default is max(4, NumCPU), which several
	// scheduler workers and the HTTP handlers share, so a busy crawl can starve
	// the API of connections on a small machine.
	DBMaxConns int

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
	// Proxy is handed to the external reader.
	Proxy string

	// --- model access, all through OpenRouter ---

	// LLMBaseURL is an OpenAI-compatible endpoint. What decides whether the
	// normalizer runs is the key, not this: the endpoint has one sensible value
	// and it is the default.
	LLMBaseURL string
	LLMAPIKey  string
	LLMModel   string

	// QueryModel reads a question written in words into search filters. Its own
	// knob because it is a far easier job than reading a lecture page, and a
	// person is waiting for it — it should be possible to make it cheaper and
	// faster without touching the normalizer.
	QueryModel string

	EmbedModel string
	EmbedDim   int

	// AuthPublicKeyFile is the PEM RSA public half of the signer whose tokens
	// /discovery/search accepts. Unprefixed on purpose: it is the platform's
	// key, the same file the orchestrator reads, and giving it a second name
	// here would be two names for one path. Unset means that route refuses.
	AuthPublicKeyFile string
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

		SchedulerEnabled: envBool("LECTORIUM_DISCOVERY_SCHEDULER_ENABLED", false),
		SchedulerWorkers: envInt("LECTORIUM_DISCOVERY_SCHEDULER_WORKERS", 4),
		PageTimeout:      envDuration("LECTORIUM_DISCOVERY_PAGE_TIMEOUT", 10*time.Minute),
		DBMaxConns:       envInt("LECTORIUM_DISCOVERY_DB_MAX_CONNS", 16),

		UserAgent:         env("LECTORIUM_DISCOVERY_USER_AGENT", "LectoriumDiscovery/1.0 (+https://shruti.app/about)"),
		DefaultCrawlDelay: envDuration("LECTORIUM_DISCOVERY_CRAWL_DELAY", time.Second),
		RequestTimeout:    envDuration("LECTORIUM_DISCOVERY_REQUEST_TIMEOUT", 30*time.Second),
		MaxBodyBytes:      int64(envInt("LECTORIUM_DISCOVERY_MAX_BODY_BYTES", 8<<20)),
		// A datacenter address reading YouTube is met with a bot check, so the
		// one host that needs an external reader also needs somewhere else to
		// be read from.
		Proxy: env("LECTORIUM_DISCOVERY_PROXY", ""),

		LLMBaseURL: env("LECTORIUM_DISCOVERY_LLM_BASE_URL", "https://openrouter.ai/api/v1"),
		LLMAPIKey:  os.Getenv("LECTORIUM_DISCOVERY_LLM_API_KEY"),
		// The same default compose and the env template carry. They disagreed
		// for a while, which meant `discovery parse` on a laptop read pages
		// with a different model than production — and since the prompt version
		// and the input hash are model-scoped, it shifted the hashes too.
		LLMModel: env("LECTORIUM_DISCOVERY_LLM_MODEL", "google/gemini-3.1-flash-lite"),

		QueryModel: env("LECTORIUM_DISCOVERY_QUERY_MODEL", "google/gemini-3.1-flash-lite"),

		EmbedModel: env("LECTORIUM_DISCOVERY_EMBED_MODEL", "openai/text-embedding-3-small"),
		EmbedDim:   envInt("LECTORIUM_DISCOVERY_EMBED_DIM", 1536),

		AuthPublicKeyFile: env("AUTH_JWT_PUBLIC_KEY_FILE", ""),
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 8 << 20
	}
	if cfg.DBMaxConns <= 0 {
		cfg.DBMaxConns = 16
	}
	// A pool smaller than the number of workers is a queue in front of the
	// database, and every handler waits behind the crawl.
	if cfg.DBMaxConns < cfg.SchedulerWorkers+4 {
		cfg.DBMaxConns = cfg.SchedulerWorkers + 4
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
		missing = append(missing, "LECTORIUM_DISCOVERY_LLM_BASE_URL")
	}
	if c.LLMAPIKey == "" {
		missing = append(missing, "LECTORIUM_DISCOVERY_LLM_API_KEY")
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
