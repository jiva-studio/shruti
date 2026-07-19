// Package wire is the publish-service's composition root: it assembles the
// Postgres pool (with embedded-migration apply + schema gate), the HTTP handler,
// and — when the streams broker is configured — the `track.ready` consumer, the
// outbox relay to `track.published`, and the promotion ticker, from a validated
// Config, keeping cmd/publish-service thin.
package wire

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/lectorium/publish/internal/application/ingest"
	"github.com/jiva-studio/lectorium/publish/internal/application/promote"
	"github.com/jiva-studio/lectorium/publish/internal/catalog"
	"github.com/jiva-studio/lectorium/publish/internal/config"
	"github.com/jiva-studio/lectorium/publish/internal/handler"
	"github.com/jiva-studio/lectorium/publish/internal/infra/blob/bunny"
	blobs3 "github.com/jiva-studio/lectorium/publish/internal/infra/blob/s3"
	"github.com/jiva-studio/lectorium/publish/internal/infra/events/redisstream"
	"github.com/jiva-studio/lectorium/publish/internal/pending"
	"github.com/jiva-studio/lectorium/publish/internal/store"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Pool and Redis and must close them on shutdown. Consumer, Relay,
// and Promoter are nil when their prerequisites are not configured — the service
// still serves HTTP in that case.
type Deps struct {
	Pool     *pgxpool.Pool
	Redis    *redis.Client
	Handler  http.Handler
	Consumer *redisstream.Consumer
	Relay    *redisstream.Relay
	Promoter *promote.Promoter
}

// Build connects the pool, applies migrations, verifies the schema, wires the
// HTTP router, and — when configured — assembles the broker transport and the
// promotion ticker. On any failure it closes whatever it opened.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := store.SchemaReady(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("schema not ready: %w", err)
	}

	deps := &Deps{
		Pool:    pool,
		Handler: handler.NewRouter(handler.RouterDeps{Pool: pool}),
	}

	// The broker is optional: without STREAMS_REDIS_URL the service is HTTP-only
	// (health/readiness), which keeps local/dev boots trivial.
	if cfg.StreamsRedisURL == "" {
		slog.WarnContext(ctx, "streams_disabled", "reason", "STREAMS_REDIS_URL unset")
		return deps, nil
	}

	rdb, err := redisstream.Connect(ctx, cfg.StreamsRedisURL)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect streams: %w", err)
	}
	deps.Redis = rdb

	repo := store.New(pool)

	// The relay drains the outbox (track.published) whenever the broker is up.
	// *store.Repo implements redisstream.OutboxSource (DrainUnpublished) directly.
	deps.Relay = redisstream.NewRelay(rdb, repo, cfg.StreamMaxLen)

	// The track.ready consumer always runs when the broker is up — ingesting a
	// ready track needs no S3/catalog config.
	deps.Consumer = redisstream.NewConsumer(
		rdb, cfg.TrackEventsStream, cfg.ConsumerGroup, cfg.ConsumerName, ingest.New(repo),
	)

	// The promotion ticker only runs when its prerequisites (S3 for the
	// pending.db upload + a catalog source) are present; otherwise ingest still
	// works and the ticker is simply off.
	if ready, missing := cfg.PromotionReady(); !ready {
		slog.WarnContext(ctx, "promoter_disabled", "missing", missing)
		return deps, nil
	}
	// The blob backend MUST match what the public CDN serves from: "bunny"
	// (global) writes the pending.db + reads current.db from Bunny Edge Storage
	// over its HTTP API; "s3" (RU / dev) uses the AWS SDK. Both expose the same
	// Put/Get/Exists surface promote.Uploader + catalog.blobGetter require.
	blob, err := buildBlob(ctx, cfg)
	if err != nil {
		pool.Close()
		_ = rdb.Close()
		return nil, fmt.Errorf("blob: %w", err)
	}
	var fetcher catalog.Fetcher
	if cfg.CorpusCatalogURL != "" {
		fetcher = catalog.NewHTTPFetcher(cfg.CorpusCatalogURL)
	} else {
		fetcher = catalog.NewS3Fetcher(blob, cfg.CorpusCatalogS3Key)
	}
	deps.Promoter = promote.New(promote.Deps{
		Repo:            repo,
		Catalog:         catalog.NewReader(fetcher),
		Blob:            blob,
		Rows:            func(c context.Context) ([]pending.Row, error) { return pending.QueryRows(c, pool) },
		PublishedStream: cfg.TrackPublishedStream,
		PendingKey:      cfg.PendingS3Key,
		Interval:        cfg.TickInterval,
	})
	return deps, nil
}

// blobStore is the Put/Get/Exists surface both blob backends expose and that the
// promoter (Put) + catalog fetcher (Get) consume.
type blobStore interface {
	Put(ctx context.Context, key string, body []byte, contentType string) error
	Get(ctx context.Context, key string) ([]byte, error)
	Exists(ctx context.Context, key string) (bool, error)
}

// buildBlob selects the blob backend by STORAGE_BACKEND: "bunny" (Bunny Edge
// Storage over its HTTP API) or "s3" (AWS SDK against AWS or an S3-compatible
// endpoint). PromotionReady() has already verified the backend's credentials.
func buildBlob(ctx context.Context, cfg *config.Config) (blobStore, error) {
	if cfg.UsesBunny() {
		return bunny.New(cfg.StorageZone, cfg.StorageEndpoint, cfg.StorageKey)
	}
	return blobs3.New(ctx, blobs3.Options{
		Bucket:         cfg.S3Bucket,
		Region:         cfg.S3Region,
		Endpoint:       cfg.S3Endpoint,
		AccessKeyID:    cfg.S3AccessKeyID,
		SecretKey:      cfg.S3SecretKey,
		ForcePathStyle: cfg.S3ForcePathStyle,
	})
}
