// Package wire is the orchestrator's composition root: it assembles the
// Postgres pool (with embedded-migration apply + schema gate), the HTTP
// handler, and — when the streams broker is configured — the transactional
// outbox relay plus the TWO Redis-Streams consumers that make up the
// coordinator seam (the `ingest.request` handler and the `ingest.result`
// handler), from a validated Config, keeping cmd/orchestrator thin.
//
// The orchestrator is a THIN coordinator: it no longer builds any
// fetch/transcribe/store adapters (those live in the separate `ingest` worker).
// Its only pipeline prerequisite is the PRO-tier verifier.
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
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/events/redisstream"
	jobpg "github.com/jiva-studio/lectorium/orchestrator/internal/infra/jobrepo/postgres"
	"github.com/jiva-studio/lectorium/orchestrator/internal/store"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Pool and Redis and must close them on shutdown. The consumers and
// Relay are nil when the streams broker (or the tier verifier) is not
// configured — the service still serves HTTP in that case.
type Deps struct {
	Pool            *pgxpool.Pool
	Redis           *redis.Client
	Handler         http.Handler
	RequestConsumer *redisstream.Consumer
	ResultConsumer  *redisstream.Consumer
	Relay           *redisstream.Relay
}

// Build connects the pool, applies migrations, verifies the schema, wires the
// HTTP router, and — when configured — assembles the outbox relay and the two
// coordinator consumers. On any failure it closes whatever it opened.
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

	repo := jobpg.New(pool)

	// The token verifier gates BOTH the ingest API and the stream consumers (a
	// consumed ingest.request must re-verify pro). Built once from the auth key;
	// nil when unset/invalid, which disables both.
	var verifier *authjwt.Verifier
	if v, verr := authjwt.NewFromFile(cfg.AuthPublicKeyFile); cfg.AuthPublicKeyFile != "" && verr == nil {
		verifier = v
	} else if verr != nil {
		slog.WarnContext(ctx, "auth_verifier_disabled", "reason", "AUTH_JWT_PUBLIC_KEY_FILE(invalid)")
	}

	// The ingest control-plane API (POST /ingest + GET /ingest/{id}) needs only
	// the job store and the verifier — NOT the broker. So it comes up whenever the
	// auth key is configured, independent of Redis: the create tx writes the
	// outbox, which the relay drains once the broker is present. The routes report
	// 503 while the verifier is absent.
	routerDeps := handler.RouterDeps{Pool: pool, Jobs: repo}
	if verifier != nil {
		routerDeps.Submitter = runingest.NewRequestHandler(ingestDeps(cfg, repo, verifier))
		routerDeps.Verifier = verifier
	}

	deps := &Deps{
		Pool:    pool,
		Handler: handler.NewRouter(routerDeps),
	}

	// The broker is optional: without STREAMS_REDIS_URL the service is
	// HTTP-only (health/readiness + the ingest API), which keeps local/dev boots
	// trivial.
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

	// The outbox relay always runs when the broker is up: it drains whatever the
	// coordinator commits — both track.events AND ingest.work rows (it publishes
	// each row to its own topic).
	deps.Relay = redisstream.NewRelay(rdb, repo, cfg.StreamMaxLen)

	// The consumers only start when the tier verifier is present; otherwise a
	// consumed ingest.request would fail re-verification. (The `ingest.request`
	// stream is the legacy chat-driven entry, retired in favour of the API; the
	// consumer stays as a dormant fallback until the producer is removed.)
	if verifier == nil {
		slog.WarnContext(ctx, "ingest_consumers_disabled", "missing", "AUTH_JWT_PUBLIC_KEY_FILE")
		return deps, nil
	}
	d := ingestDeps(cfg, repo, verifier)
	deps.RequestConsumer = redisstream.NewConsumer(
		rdb, cfg.IngestStream, cfg.ConsumerGroup, cfg.ConsumerName, runingest.NewRequestHandler(d),
	)
	deps.ResultConsumer = redisstream.NewConsumer(
		rdb, cfg.ResultStream, cfg.ResultConsumerGroup, cfg.ConsumerName, runingest.NewResultHandler(d),
	)
	return deps, nil
}

// ingestDeps assembles the runingest.Deps shared by the HTTP submitter and the
// stream consumers — the job store (both repository and outbox event bus) plus
// the tier verifier and the stream-name/attempt config.
func ingestDeps(cfg *config.Config, repo *jobpg.Repo, verifier *authjwt.Verifier) runingest.Deps {
	return runingest.Deps{
		Repo:              repo,
		Events:            repo,
		Tier:              verifier,
		MaxAttempts:       cfg.MaxAttempts,
		TrackEventsStream: cfg.TrackEventsStream,
		WorkStream:        cfg.WorkStream,
	}
}

// The persistence repo (*jobpg.Repo) implements redisstream.OutboxSource
// directly via DrainUnpublished — the relay hands it an XADD callback, so the
// claim + publish + mark all commit in one FOR UPDATE SKIP LOCKED transaction
// and no row type crosses the package boundary.
