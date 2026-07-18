// Package wire is the orchestrator's composition root: it assembles the
// concrete runtime dependencies (Postgres pool, embedded-migration apply,
// schema gate, HTTP handler, and — for the ingest pipeline — the fetch /
// transcribe / store adapters, the runingest use case, and the Redis-Streams
// consumer + outbox relay) from a validated Config, keeping cmd/orchestrator
// thin.
package wire

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/lectorium/orchestrator/internal/application/runingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/config"
	"github.com/jiva-studio/lectorium/orchestrator/internal/handler"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/authjwt"
	blobs3 "github.com/jiva-studio/lectorium/orchestrator/internal/infra/blob/s3"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/events/redisstream"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/fetch/ytdlp"
	jobpg "github.com/jiva-studio/lectorium/orchestrator/internal/infra/jobrepo/postgres"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/review"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/sys"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/transcribe/deepgram"
	"github.com/jiva-studio/lectorium/orchestrator/internal/store"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Pool and Redis and must close them on shutdown. Consumer and
// Relay are nil when the streams broker (or the pipeline prerequisites) are not
// configured — the service still serves HTTP in that case.
type Deps struct {
	Pool     *pgxpool.Pool
	Redis    *redis.Client
	Handler  http.Handler
	Consumer *redisstream.Consumer
	Relay    *redisstream.Relay
}

// Build connects the pool, applies migrations, verifies the schema, wires the
// HTTP router, and — when configured — assembles the ingest pipeline and its
// broker transport. On any failure it closes whatever it opened.
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

	// The broker is optional: without STREAMS_REDIS_URL the service is
	// HTTP-only (health/readiness), which keeps local/dev boots trivial.
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

	repo := jobpg.New(pool)

	// The outbox relay always runs when the broker is up: it drains whatever
	// lifecycle events the pipeline commits.
	deps.Relay = redisstream.NewRelay(rdb, outboxAdapter{repo}, cfg.StreamMaxLen)

	// The consumer only starts when every pipeline prerequisite is present;
	// otherwise a consumed message would fail with a misconfiguration.
	svc, ready, missing := buildPipeline(ctx, cfg, repo)
	if !ready {
		slog.WarnContext(ctx, "ingest_consumer_disabled", "missing", missing)
		return deps, nil
	}
	deps.Consumer = redisstream.NewConsumer(rdb, cfg.IngestStream, cfg.ConsumerGroup, cfg.ConsumerName, svc)
	return deps, nil
}

// buildPipeline assembles the runingest use case. ready is false (with the list
// of missing config keys) when a required credential is absent.
func buildPipeline(ctx context.Context, cfg *config.Config, repo *jobpg.Repo) (*runingest.Service, bool, []string) {
	var missing []string
	if cfg.DeepgramAPIKey == "" {
		missing = append(missing, "DEEPGRAM_API_KEY")
	}
	if cfg.S3Bucket == "" {
		missing = append(missing, "S3_BUCKET")
	}
	if cfg.AuthPublicKeyFile == "" {
		missing = append(missing, "AUTH_JWT_PUBLIC_KEY_FILE")
	}

	verifier, err := authjwt.NewFromFile(cfg.AuthPublicKeyFile)
	if cfg.AuthPublicKeyFile != "" && err != nil {
		missing = append(missing, "AUTH_JWT_PUBLIC_KEY_FILE(invalid)")
	}
	blob, err := blobs3.New(ctx, cfg.S3Bucket, cfg.S3Region, cfg.S3Endpoint)
	if cfg.S3Bucket != "" && err != nil {
		missing = append(missing, "S3(config)")
	}
	if len(missing) > 0 {
		return nil, false, missing
	}

	fetcher := ytdlp.New(ytdlp.Options{
		Bin:        cfg.YtdlpBin,
		Proxy:      cfg.YtdlpProxy,
		MaxBytes:   cfg.MaxAudioBytes,
		MaxSeconds: cfg.MaxAudioSeconds,
	})
	svc := runingest.New(runingest.Deps{
		Repo:              repo,
		Events:            repo,
		Fetcher:           fetcher,
		Transcriber:       deepgram.New(cfg.DeepgramAPIKey, cfg.DeepgramModel),
		Reviewer:          review.New(),
		Blob:              blob,
		Tier:              verifier,
		Clock:             sys.Clock{},
		IDs:               sys.IDGen{},
		MaxAttempts:       cfg.MaxAttempts,
		TrackEventsStream: cfg.TrackEventsStream,
	})
	return svc, true, nil
}

// outboxAdapter bridges the persistence repo's outbox drain to the relay's
// transport-facing OutboxSource, converting the row type across the boundary so
// neither package imports the other.
type outboxAdapter struct{ repo *jobpg.Repo }

func (a outboxAdapter) FetchUnpublished(ctx context.Context, limit int) ([]redisstream.OutboxRow, error) {
	rows, err := a.repo.FetchUnpublished(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]redisstream.OutboxRow, len(rows))
	for i, r := range rows {
		out[i] = redisstream.OutboxRow{Seq: r.Seq, Topic: r.Topic, Payload: r.Payload}
	}
	return out, nil
}

func (a outboxAdapter) MarkPublished(ctx context.Context, seq int64) error {
	return a.repo.MarkPublished(ctx, seq)
}
