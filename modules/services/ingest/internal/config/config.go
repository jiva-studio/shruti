// Package config loads runtime configuration from environment variables.
package config

import (
	"os"
	"strconv"
)

// Config is the ingest worker's runtime configuration. The worker is STATELESS
// — there is no DATABASE_URL and no JWT verification here (the orchestrator
// owns the job store and re-verifies the PRO tier). The worker consumes
// `ingest.work`, does the heavy fetch/transcribe/store, and reports on
// `ingest.result`.
type Config struct {
	// Port is the HTTP port (health only). The pipeline is broker-driven.
	Port string
	// Env tags log lines. "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime; surfaces in every log line.
	ServiceVersion string

	// --- Streams broker (dedicated redis-streams instance). Empty
	// StreamsRedisURL disables the consumer so the service can still boot for
	// HTTP-only ops. ---
	StreamsRedisURL string // STREAMS_REDIS_URL, e.g. redis://redis-streams:6379/0
	WorkStream      string // INGEST_WORK_STREAM, consumed  (default "ingest.work")
	ResultStream    string // INGEST_RESULT_STREAM, produced (default "ingest.result")
	ConsumerGroup   string // CONSUMER_GROUP (default "ingest")
	ConsumerName    string // this container's consumer id (default hostname)
	StreamMaxLen    int64  // approximate MAXLEN cap for the result stream

	// --- Fetcher ---
	YtdlpProxy      string // YTDLP_PROXY — host-only proxy passed to yt-dlp --proxy
	YtdlpBin        string // YTDLP_BIN (default "yt-dlp")
	MaxAudioBytes   int64  // MAX_AUDIO_BYTES cap on a downloaded artifact
	MaxAudioSeconds int64  // MAX_AUDIO_DURATION_SECONDS cap on source duration

	// --- Transcriber (Deepgram) ---
	DeepgramAPIKey string // DEEPGRAM_API_KEY
	DeepgramModel  string // DEEPGRAM_MODEL (default "nova-2")

	// --- BlobStore (S3) ---
	S3Bucket     string // S3_BUCKET
	S3Region     string // S3_REGION (default "us-east-1")
	S3Endpoint   string // S3_ENDPOINT (optional; for S3-compatible stores)
	S3PublicBase string // S3_PUBLIC_BASE (optional CDN base for URL composition)
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:           env("PORT", "8088"),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),

		StreamsRedisURL: env("STREAMS_REDIS_URL", ""),
		WorkStream:      env("INGEST_WORK_STREAM", "ingest.work"),
		ResultStream:    env("INGEST_RESULT_STREAM", "ingest.result"),
		ConsumerGroup:   env("CONSUMER_GROUP", "ingest"),
		ConsumerName:    env("CONSUMER_NAME", hostname()),
		StreamMaxLen:    int64(envInt("INGEST_RESULT_MAXLEN", 10000)),

		YtdlpProxy:      env("YTDLP_PROXY", ""),
		YtdlpBin:        env("YTDLP_BIN", "yt-dlp"),
		MaxAudioBytes:   int64(envInt("MAX_AUDIO_BYTES", 512*1024*1024)),      // 512 MiB
		MaxAudioSeconds: int64(envInt("MAX_AUDIO_DURATION_SECONDS", 4*60*60)), // 4h

		DeepgramAPIKey: env("DEEPGRAM_API_KEY", ""),
		DeepgramModel:  env("DEEPGRAM_MODEL", "nova-2"),

		S3Bucket:     env("S3_BUCKET", ""),
		S3Region:     env("S3_REGION", "us-east-1"),
		S3Endpoint:   env("S3_ENDPOINT", ""),
		S3PublicBase: env("S3_PUBLIC_BASE", ""),
	}
	if cfg.StreamMaxLen <= 0 {
		cfg.StreamMaxLen = 10000
	}
	return cfg, nil
}

// hostname returns the container hostname (the natural per-consumer id within a
// Redis consumer group); falls back to a constant if unavailable.
func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "ingest"
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
