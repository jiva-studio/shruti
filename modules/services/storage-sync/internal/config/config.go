// Package config loads storage-sync's environment into a validated Config.
//
// The service has two independent drivers and each can be off:
//   - the periodic full pass runs whenever Interval > 0 (Interval == 0 means
//     "run once and exit", which is how the one-shot job mode works);
//   - the `track.events` consumer runs only when StreamsRedisURL is set, so a
//     deployment without the broker still mirrors on the interval.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the fully-resolved service configuration.
type Config struct {
	// Source — Bunny Edge Storage (the source of truth).
	StorageZone     string // STORAGE_ZONE
	StorageKey      string // STORAGE_KEY
	StorageEndpoint string // STORAGE_ENDPOINT

	// Mirror — Yandex Object Storage (the Russia mirror).
	YandexBucket      string // YANDEX_BUCKET
	YandexEndpoint    string // YANDEX_ENDPOINT
	YandexRegion      string // YANDEX_REGION
	YandexAccessKeyID string // YANDEX_ACCESS_KEY_ID
	YandexSecretKey   string // YANDEX_SECRET_ACCESS_KEY

	// Pass policy.
	Prefix      string        // SYNC_PREFIX ("" = whole bucket)
	Concurrency int           // SYNC_CONCURRENCY
	Delete      bool          // SYNC_DELETE — prune mirror objects gone from source
	DryRun      bool          // DRY_RUN
	Interval    time.Duration // SYNC_INTERVAL seconds (0 = run once and exit)

	// Broker — the event-driven fast path. Empty URL disables the consumer.
	StreamsRedisURL   string // STREAMS_REDIS_URL
	TrackEventsStream string // TRACK_EVENTS_STREAM
	ConsumerGroup     string // CONSUMER_GROUP
	ConsumerName      string // CONSUMER_NAME

	// Health surface. Empty HTTPAddr disables the server (one-shot job mode).
	HTTPAddr string // HTTP_ADDR

	Env            string // ENV
	ServiceVersion string // SERVICE_VERSION
}

// StaleAfter is the readiness budget: how long the mirror may go without a
// successful full pass before /readyz reports stale. Three intervals tolerates
// a couple of transient failures (Bunny hiccup, Yandex 5xx) without flapping,
// while still catching a genuinely wedged mirror well inside a working day.
func (c *Config) StaleAfter() time.Duration {
	if c.Interval <= 0 {
		return 0 // one-shot mode — nothing to go stale
	}
	return 3 * c.Interval
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	v, err := strconv.Atoi(env(k, ""))
	if err != nil {
		return def
	}
	return v
}

// Load reads the environment and validates the parts the service cannot run
// without.
func Load() (*Config, error) {
	conc := envInt("SYNC_CONCURRENCY", 16)
	if conc < 1 {
		conc = 16
	}
	c := &Config{
		StorageZone:     os.Getenv("STORAGE_ZONE"),
		StorageKey:      os.Getenv("STORAGE_KEY"),
		StorageEndpoint: env("STORAGE_ENDPOINT", ""),

		YandexBucket:      os.Getenv("YANDEX_BUCKET"),
		YandexEndpoint:    env("YANDEX_ENDPOINT", ""),
		YandexRegion:      env("YANDEX_REGION", ""),
		YandexAccessKeyID: os.Getenv("YANDEX_ACCESS_KEY_ID"),
		YandexSecretKey:   os.Getenv("YANDEX_SECRET_ACCESS_KEY"),

		Prefix:      env("SYNC_PREFIX", ""),
		Concurrency: conc,
		Delete:      env("SYNC_DELETE", "false") == "true",
		DryRun:      env("DRY_RUN", "false") == "true",
		Interval:    time.Duration(envInt("SYNC_INTERVAL", 3600)) * time.Second,

		StreamsRedisURL:   os.Getenv("STREAMS_REDIS_URL"),
		TrackEventsStream: env("TRACK_EVENTS_STREAM", "track.events"),
		ConsumerGroup:     env("CONSUMER_GROUP", "storage-sync"),
		ConsumerName:      env("CONSUMER_NAME", "storage-sync-1"),

		HTTPAddr: env("HTTP_ADDR", ":8089"),

		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
	}
	// The Yandex credentials used to be demanded by compose (`:?`), which
	// failed the whole file — on every host, including a proxy that never
	// runs this service. Demanding them here fails only the service that
	// needs them, and does it at startup rather than at the first S3 call.
	if c.StorageZone == "" || c.StorageKey == "" || c.YandexBucket == "" ||
		c.YandexAccessKeyID == "" || c.YandexSecretKey == "" {
		return nil, fmt.Errorf(
			"STORAGE_ZONE, STORAGE_KEY, YANDEX_BUCKET, YANDEX_ACCESS_KEY_ID and YANDEX_SECRET_ACCESS_KEY are required")
	}
	return c, nil
}
