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

	// --- BlobStore ---
	// StorageBackend selects where content-addressed artifacts are written:
	// "s3" (AWS / S3-compatible like Yandex, via S3Endpoint) or "bunny" (Bunny
	// Edge Storage — NOT S3-compatible; a plain HTTP API). It MUST match the
	// backend the public CDN (b-cdn) serves from, or the app/chat can't read the
	// audio + transcript. On global this is "bunny"; the RU proxy uses "s3".
	StorageBackend string // STORAGE_BACKEND (default "s3")

	// S3 backend.
	S3Bucket   string // S3_BUCKET
	S3Region   string // S3_REGION (default "us-east-1")
	S3Endpoint string // S3_ENDPOINT (optional; for S3-compatible stores)

	// Bunny backend (same env names as share-audio / storage-sync).
	StorageZone     string // STORAGE_ZONE (Bunny storage-zone name, e.g. akds-lectorium-eu)
	StorageEndpoint string // STORAGE_ENDPOINT (optional; default https://storage.bunnycdn.com)
	StorageKey      string // STORAGE_KEY (storage-zone read+write password)

	// --- Metadata extractor (LLM, OpenAI-compatible; OpenRouter by default) ---
	// OPTIONAL: extraction runs only when both key and model are set. Without
	// them the worker skips it and a track keeps just its raw title — extraction
	// never blocks an ingest.
	MetadataLLMEndpoint string // METADATA_LLM_ENDPOINT (default OpenRouter)
	MetadataLLMAPIKey   string // METADATA_LLM_API_KEY
	MetadataLLMModel    string // METADATA_LLM_MODEL

	// --- Transcript reviewer (LLM, OpenAI-compatible) ---
	// OPTIONAL: an LLM cleanup/segmentation pass over the transcript runs only
	// when both key and model are set; otherwise the deterministic per-segment
	// normalize is used. Review never blocks an ingest.
	ReviewLLMEndpoint  string // REVIEW_LLM_ENDPOINT (default OpenRouter)
	ReviewLLMAPIKey    string // REVIEW_LLM_API_KEY
	ReviewLLMModel     string // REVIEW_LLM_MODEL
	ReviewLLMReasoning string // REVIEW_LLM_REASONING ("" | off | on | low|medium|high | <int>)
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

		StorageBackend: env("STORAGE_BACKEND", "s3"),

		S3Bucket:   env("S3_BUCKET", ""),
		S3Region:   env("S3_REGION", "us-east-1"),
		S3Endpoint: env("S3_ENDPOINT", ""),

		StorageZone:     env("STORAGE_ZONE", ""),
		StorageEndpoint: env("STORAGE_ENDPOINT", ""),
		StorageKey:      os.Getenv("STORAGE_KEY"),

		MetadataLLMEndpoint: env("METADATA_LLM_ENDPOINT", "https://openrouter.ai/api/v1"),
		MetadataLLMAPIKey:   os.Getenv("METADATA_LLM_API_KEY"),
		MetadataLLMModel:    env("METADATA_LLM_MODEL", ""),

		ReviewLLMEndpoint:  env("REVIEW_LLM_ENDPOINT", "https://openrouter.ai/api/v1"),
		ReviewLLMAPIKey:    os.Getenv("REVIEW_LLM_API_KEY"),
		ReviewLLMModel:     env("REVIEW_LLM_MODEL", ""),
		ReviewLLMReasoning: env("REVIEW_LLM_REASONING", ""),
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
