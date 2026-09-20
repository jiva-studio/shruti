// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the publish-service runtime configuration. The service is the
// PROMOTION side of the personal-library pipeline: it consumes `track.ready`
// (emitted by the orchestrator ingest service) into its OWN Postgres `tracks`
// table, and on a periodic tick reconciles that table against the published
// corpus catalog — flipping matched tracks to published, emitting
// `track.published`, and rebuilding the `pending.db` review artifact on S3.
type Config struct {
	// Port is the HTTP port (health + readiness). The pipeline is broker- and
	// ticker-driven, not request/response.
	Port string
	// DatabaseURL points at the publish-service's OWN Postgres — the `tracks`
	// table is its source of truth; it never touches the shared lectorium DB.
	DatabaseURL string
	// Env tags log lines. "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime; surfaces in every log line.
	ServiceVersion string

	// --- Streams broker (dedicated redis-streams instance, see
	// services/README-streams.md). Empty StreamsRedisURL disables the consumer
	// + relay + ticker so the service can still boot for HTTP-only ops. ---
	StreamsRedisURL string // STREAMS_REDIS_URL, e.g. redis://redis-streams:6379/0
	// TrackEventsStream is CONSUMED (orchestrator's lifecycle stream); the
	// consumer filters for `track.ready`.
	TrackEventsStream string // TRACK_EVENTS_STREAM (default "track.events")
	// TrackPublishedStream is PRODUCED once a track is promoted.
	TrackPublishedStream string // TRACK_PUBLISHED_STREAM (default "track.published")
	ConsumerGroup        string // CONSUMER_GROUP (default "publish")
	ConsumerName         string // this container's consumer id (default hostname)
	StreamMaxLen         int64  // approximate MAXLEN cap for produced streams

	// --- Promotion ticker ---
	// TickInterval is how often the catalog is reconciled and pending.db
	// rebuilt.
	TickInterval time.Duration
	// MediaBaseURL is the public CDN origin the corpus is published to (the
	// same base the app reads). The catalog has no fixed filename: every build
	// is uploaded under `public/db/lectorium.{version}.db` and advertised in
	// `public/config.json`, so the live version is resolved from that manifest
	// on every tick. When unset, the same two objects are read through the
	// configured blob backend instead.
	MediaBaseURL string

	// --- BlobStore ---
	// StorageBackend selects the blob backend: "s3" (AWS / S3-compatible like
	// Yandex) or "bunny" (Bunny Edge Storage — NOT S3-compatible). It must match
	// the backend the public CDN serves from. On global this is "bunny".
	StorageBackend string // STORAGE_BACKEND (default "s3")

	// S3 backend.
	S3Bucket         string // S3_BUCKET
	S3Region         string // S3_REGION (default "us-east-1")
	S3Endpoint       string // S3_ENDPOINT (optional; for S3-compatible stores)
	S3AccessKeyID    string // S3_ACCESS_KEY_ID (optional static creds)
	S3SecretKey      string // S3_SECRET_ACCESS_KEY
	S3ForcePathStyle bool   // S3_FORCE_PATH_STYLE

	// Bunny backend (same env names as share-audio / storage-sync).
	StorageZone     string // STORAGE_ZONE (Bunny storage-zone name)
	StorageEndpoint string // STORAGE_ENDPOINT (optional; default https://storage.bunnycdn.com)
	StorageKey      string // STORAGE_KEY (storage-zone read+write password)

	// PendingS3Key is the object key the rebuilt pending.db is uploaded to.
	PendingS3Key string // PENDING_S3_KEY (default "public/db/pending.db")
}

// UsesBunny reports whether the blob backend is Bunny Edge Storage.
func (c *Config) UsesBunny() bool { return strings.EqualFold(c.StorageBackend, "bunny") }

func Load() (*Config, error) {
	cfg := &Config{
		Port:           env("PORT", "8087"),
		DatabaseURL:    env("DATABASE_URL", ""),
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),

		StreamsRedisURL:      env("STREAMS_REDIS_URL", ""),
		TrackEventsStream:    env("TRACK_EVENTS_STREAM", "track.events"),
		TrackPublishedStream: env("TRACK_PUBLISHED_STREAM", "track.published"),
		ConsumerGroup:        env("CONSUMER_GROUP", "publish"),
		ConsumerName:         env("CONSUMER_NAME", hostname()),
		StreamMaxLen:         int64(envInt("TRACK_PUBLISHED_MAXLEN", 10000)),

		TickInterval: envDuration("PUBLISH_TICK_INTERVAL", 5*time.Minute),
		MediaBaseURL: env("MEDIA_BASE_URL", ""),

		StorageBackend:   env("STORAGE_BACKEND", "s3"),
		S3Bucket:         env("S3_BUCKET", ""),
		S3Region:         env("S3_REGION", "us-east-1"),
		S3Endpoint:       env("S3_ENDPOINT", ""),
		S3AccessKeyID:    os.Getenv("S3_ACCESS_KEY_ID"),
		S3SecretKey:      os.Getenv("S3_SECRET_ACCESS_KEY"),
		S3ForcePathStyle: envBool("S3_FORCE_PATH_STYLE", false),
		StorageZone:      env("STORAGE_ZONE", ""),
		StorageEndpoint:  env("STORAGE_ENDPOINT", ""),
		StorageKey:       os.Getenv("STORAGE_KEY"),
		PendingS3Key:     env("PENDING_S3_KEY", "public/db/pending.db"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.StreamMaxLen <= 0 {
		cfg.StreamMaxLen = 10000
	}
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = 5 * time.Minute
	}
	return cfg, nil
}

// PromotionReady reports whether the ticker prerequisites are present. That is
// the blob backend alone: it carries the pending.db upload, and it is also the
// catalog source when MEDIA_BASE_URL is unset — so there is nothing further to
// require for the catalog read.
func (c *Config) PromotionReady() (bool, []string) {
	var missing []string
	if c.UsesBunny() {
		if c.StorageZone == "" {
			missing = append(missing, "STORAGE_ZONE")
		}
		if c.StorageKey == "" {
			missing = append(missing, "STORAGE_KEY")
		}
	} else if c.S3Bucket == "" {
		missing = append(missing, "S3_BUCKET")
	}
	return len(missing) == 0, missing
}

// hostname returns the container hostname (the natural per-consumer id within a
// Redis consumer group); falls back to a constant if unavailable.
func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "publish"
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
