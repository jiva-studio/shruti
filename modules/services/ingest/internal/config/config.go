// Package config loads runtime configuration from environment variables.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
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

	// JobTimeout bounds a single ingest.work: the whole fetch → transcribe →
	// store pipeline runs under a context with this deadline, so one hung yt-dlp
	// (proxy stall, bot challenge) can't wedge the single-goroutine consumer
	// forever. INGEST_JOB_TIMEOUT_SECONDS, 0 disables.
	JobTimeout time.Duration

	// --- Transcriber (Deepgram) ---
	DeepgramAPIKey string // DEEPGRAM_API_KEY
	DeepgramModel  string // DEEPGRAM_MODEL (default "nova-3")

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
	StorageZone     string // STORAGE_ZONE (Bunny storage-zone name, e.g. shruti-engine-eu)
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
	// OPTIONAL: an LLM cleanup/segmentation pass over the transcript, using the
	// SAME shared review pipeline (and the SAME hybrid baseline+premium chain) as
	// the corpus tool. Runs only when key + baseline model are set; otherwise the
	// deterministic per-segment normalize is used. Review never blocks an ingest.
	ReviewLLMEndpoint  string   // REVIEW_LLM_ENDPOINT (default OpenRouter)
	ReviewLLMAPIKey    string   // REVIEW_LLM_API_KEY
	ReviewLLMBaseline  string   // REVIEW_LLM_BASELINE — the every-chunk model
	ReviewLLMPremium   []string // REVIEW_LLM_PREMIUM — comma-sep per-island fixup chain
	ReviewLLMReasoning string   // REVIEW_LLM_REASONING ("" | off | on | low|medium|high | <int>)

	// --- Outline + description (LLM, OpenAI-compatible) ---
	// OPTIONAL: the SAME shared pipeline/outline step the corpus tool uses to
	// generate a lecture description and coarse chapter list from the reviewed
	// transcript. Runs only when key + model are set; otherwise the track is
	// stored without an outline/description. Never blocks an ingest.
	OutlineLLMEndpoint  string // OUTLINE_LLM_ENDPOINT (default OpenRouter)
	OutlineLLMAPIKey    string // OUTLINE_LLM_API_KEY
	OutlineLLMModel     string // OUTLINE_LLM_MODEL
	OutlineLLMMaxTokens int    // OUTLINE_LLM_MAX_TOKENS (0 → adapter default)
	OutlineLLMReasoning string // OUTLINE_LLM_REASONING

	// --- Translation (LLM, OpenAI-compatible) ---
	// OPTIONAL: a DEDICATED model for the title/transcript translator (on-demand
	// translate op + ingest-time translated variants). Its own knob so translation
	// can use a different Gemini model than outline. When unset, falls back to the
	// OUTLINE_LLM_* config so a default deploy still translates.
	TranslateLLMEndpoint  string // TRANSLATE_LLM_ENDPOINT (default OpenRouter)
	TranslateLLMAPIKey    string // TRANSLATE_LLM_API_KEY
	TranslateLLMModel     string // TRANSLATE_LLM_MODEL
	TranslateLLMReasoning string // TRANSLATE_LLM_REASONING
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
		JobTimeout:      time.Duration(envInt("INGEST_JOB_TIMEOUT_SECONDS", 45*60)) * time.Second,

		DeepgramAPIKey: env("DEEPGRAM_API_KEY", ""),
		DeepgramModel:  env("DEEPGRAM_MODEL", "nova-3"),

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
		ReviewLLMBaseline:  env("REVIEW_LLM_BASELINE", "google/gemini-3.1-flash-lite"),
		ReviewLLMPremium:   csv(env("REVIEW_LLM_PREMIUM", "google/gemini-3-flash-preview,google/gemini-3.1-pro-preview")),
		ReviewLLMReasoning: env("REVIEW_LLM_REASONING", ""),

		OutlineLLMEndpoint:  env("OUTLINE_LLM_ENDPOINT", "https://openrouter.ai/api/v1"),
		OutlineLLMAPIKey:    os.Getenv("OUTLINE_LLM_API_KEY"),
		OutlineLLMModel:     env("OUTLINE_LLM_MODEL", ""),
		OutlineLLMMaxTokens: envInt("OUTLINE_LLM_MAX_TOKENS", 0),
		OutlineLLMReasoning: env("OUTLINE_LLM_REASONING", ""),

		TranslateLLMEndpoint:  env("TRANSLATE_LLM_ENDPOINT", "https://openrouter.ai/api/v1"),
		TranslateLLMAPIKey:    os.Getenv("TRANSLATE_LLM_API_KEY"),
		TranslateLLMModel:     env("TRANSLATE_LLM_MODEL", ""),
		TranslateLLMReasoning: env("TRANSLATE_LLM_REASONING", ""),
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

// csv splits a comma-separated env value into trimmed, non-empty parts.
func csv(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
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
