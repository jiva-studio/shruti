// Package wire is storage-sync's composition root: it turns a validated Config
// into the mirroring core plus — when the broker is configured — the
// `track.events` consumer, keeping cmd/storage-sync thin.
package wire

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/shruti-storage-sync/internal/application/runmirror"
	"github.com/jiva-studio/shruti-storage-sync/internal/config"
	"github.com/jiva-studio/shruti-storage-sync/internal/infra/bunny"
	"github.com/jiva-studio/shruti-storage-sync/internal/infra/events/redisstream"
	"github.com/jiva-studio/shruti-storage-sync/internal/infra/yandex"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Redis and must close it on shutdown. Consumer is nil when the
// broker is not configured — the periodic pass still runs in that case.
type Deps struct {
	Mirror   *runmirror.Service
	Redis    *redis.Client
	Consumer *redisstream.Consumer
}

// Build assembles the adapters and the core. On any failure it closes whatever
// it opened.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	src, err := bunny.New(bunny.Options{
		Zone:        cfg.StorageZone,
		Key:         cfg.StorageKey,
		Endpoint:    cfg.StorageEndpoint,
		Concurrency: cfg.Concurrency,
	})
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	dst, err := yandex.New(ctx, yandex.Options{
		Bucket:      cfg.YandexBucket,
		Endpoint:    cfg.YandexEndpoint,
		Region:      cfg.YandexRegion,
		AccessKeyID: cfg.YandexAccessKeyID,
		SecretKey:   cfg.YandexSecretKey,
	})
	if err != nil {
		return nil, fmt.Errorf("mirror: %w", err)
	}

	deps := &Deps{
		Mirror: runmirror.New(runmirror.Deps{
			Source:      src,
			Mirror:      dst,
			Prefix:      cfg.Prefix,
			Concurrency: cfg.Concurrency,
			DryRun:      cfg.DryRun,
			Prune:       cfg.Delete,
		}),
	}

	// The broker is optional: without STREAMS_REDIS_URL the service is just the
	// periodic reconciler, exactly as it behaved before the fast path existed.
	if cfg.StreamsRedisURL == "" {
		slog.WarnContext(ctx, "streams_disabled", "reason", "STREAMS_REDIS_URL unset")
		return deps, nil
	}
	rdb, err := redisstream.Connect(ctx, cfg.StreamsRedisURL)
	if err != nil {
		return nil, fmt.Errorf("connect streams: %w", err)
	}
	deps.Redis = rdb
	deps.Consumer = redisstream.NewConsumer(
		rdb, cfg.TrackEventsStream, cfg.ConsumerGroup, cfg.ConsumerName, deps.Mirror,
	)
	return deps, nil
}
