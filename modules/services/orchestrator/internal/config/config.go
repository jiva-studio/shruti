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

	// --- Streams broker (dedicated redis-streams instance, see
	// services/README-streams.md). Empty StreamsRedisURL disables the
	// consumers + relay so the service can still boot for HTTP-only ops. ---
	StreamsRedisURL     string // STREAMS_REDIS_URL, e.g. redis://redis-streams:6379/0
	IngestStream        string // INGEST_STREAM, consumed  (default "ingest.request")
	WorkStream          string // INGEST_WORK_STREAM, produced → ingest worker (default "ingest.work")
	ResultStream        string // INGEST_RESULT_STREAM, consumed ← ingest worker (default "ingest.result")
	TrackEventsStream   string // TRACK_EVENTS_STREAM, produced (default "track.events")
	ConsumerGroup       string // CONSUMER_GROUP for ingest.request (default "orchestrator")
	ResultConsumerGroup string // RESULT_CONSUMER_GROUP for ingest.result (default "orchestrator-result")
	ConsumerName        string // this container's consumer id (default hostname)
	StreamMaxLen        int64  // approximate MAXLEN cap for produced streams

	// --- Tier re-verification (JWT, RS256 kid=v1, aud=chat) ---
	AuthPublicKeyFile string // AUTH_JWT_PUBLIC_KEY_FILE — PEM RSA public key
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:           env("PORT", "8086"),
		DatabaseURL:    env("DATABASE_URL", ""),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
		MaxAttempts:    envInt("MAX_ATTEMPTS", 5),

		StreamsRedisURL:     env("STREAMS_REDIS_URL", ""),
		IngestStream:        env("INGEST_STREAM", "ingest.request"),
		WorkStream:          env("INGEST_WORK_STREAM", "ingest.work"),
		ResultStream:        env("INGEST_RESULT_STREAM", "ingest.result"),
		TrackEventsStream:   env("TRACK_EVENTS_STREAM", "track.events"),
		ConsumerGroup:       env("CONSUMER_GROUP", "orchestrator"),
		ResultConsumerGroup: env("RESULT_CONSUMER_GROUP", "orchestrator-result"),
		ConsumerName:        env("CONSUMER_NAME", hostname()),
		StreamMaxLen:        int64(envInt("TRACK_EVENTS_MAXLEN", 10000)),

		AuthPublicKeyFile: env("AUTH_JWT_PUBLIC_KEY_FILE", ""),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 5
	}
	if cfg.StreamMaxLen <= 0 {
		cfg.StreamMaxLen = 10000
	}
	return cfg, nil
}

// hostname returns the container hostname (the natural per-consumer id within
// a Redis consumer group); falls back to a constant if unavailable.
func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "orchestrator"
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
