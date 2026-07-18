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
	// the source of truth; it never touches the shared shruti DB.
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
	// consumer + relay so the service can still boot for HTTP-only ops. ---
	StreamsRedisURL   string // STREAMS_REDIS_URL, e.g. redis://redis-streams:6379/0
	IngestStream      string // INGEST_STREAM, consumed  (default "ingest.request")
	TrackEventsStream string // TRACK_EVENTS_STREAM, produced (default "track.events")
	ConsumerGroup     string // CONSUMER_GROUP (default "orchestrator")
	ConsumerName      string // this container's consumer id (default hostname)
	StreamMaxLen      int64  // approximate MAXLEN cap for produced streams

	// --- Fetcher (#1221) ---
	YtdlpProxy      string // YTDLP_PROXY — host-only proxy passed to yt-dlp --proxy
	YtdlpBin        string // YTDLP_BIN (default "yt-dlp")
	MaxAudioBytes   int64  // MAX_AUDIO_BYTES cap on a downloaded artifact
	MaxAudioSeconds int64  // MAX_AUDIO_DURATION_SECONDS cap on source duration

	// --- Transcriber (#1222, Deepgram) ---
	DeepgramAPIKey string // DEEPGRAM_API_KEY
	DeepgramModel  string // DEEPGRAM_MODEL (default "nova-2")

	// --- BlobStore (#1223, S3) ---
	S3Bucket     string // S3_BUCKET
	S3Region     string // S3_REGION (default "us-east-1")
	S3Endpoint   string // S3_ENDPOINT (optional; for S3-compatible stores)
	S3PublicBase string // S3_PUBLIC_BASE (optional CDN base for URL composition)

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

		StreamsRedisURL:   env("STREAMS_REDIS_URL", ""),
		IngestStream:      env("INGEST_STREAM", "ingest.request"),
		TrackEventsStream: env("TRACK_EVENTS_STREAM", "track.events"),
		ConsumerGroup:     env("CONSUMER_GROUP", "orchestrator"),
		ConsumerName:      env("CONSUMER_NAME", hostname()),
		StreamMaxLen:      int64(envInt("TRACK_EVENTS_MAXLEN", 10000)),

		YtdlpProxy:      env("YTDLP_PROXY", ""),
		YtdlpBin:        env("YTDLP_BIN", "yt-dlp"),
		MaxAudioBytes:   int64(envInt("MAX_AUDIO_BYTES", 512*1024*1024)),  // 512 MiB
		MaxAudioSeconds: int64(envInt("MAX_AUDIO_DURATION_SECONDS", 4*60*60)), // 4h

		DeepgramAPIKey: env("DEEPGRAM_API_KEY", ""),
		DeepgramModel:  env("DEEPGRAM_MODEL", "nova-2"),

		S3Bucket:     env("S3_BUCKET", ""),
		S3Region:     env("S3_REGION", "us-east-1"),
		S3Endpoint:   env("S3_ENDPOINT", ""),
		S3PublicBase: env("S3_PUBLIC_BASE", ""),

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
