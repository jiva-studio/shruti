// Package wire is the composition root. Optional subsystems stay nil when they
// are unconfigured, and the service says so in the log rather than failing.
package wire

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/application/crawl"
	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/config"
	"github.com/jiva-studio/shruti/discovery/internal/handler"
	"github.com/jiva-studio/shruti/discovery/internal/infra/embed"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Deps is what a built service consists of.
type Deps struct {
	Pool      *pgxpool.Pool
	Handler   http.Handler
	Scheduler *crawl.Scheduler
}

// Build connects the pool, applies the embedded migrations, and wires the
// router. It starts no crawl: the scheduler is returned rather than started,
// and boot must not touch anybody's website.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("db connect: %w", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := store.SchemaReady(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("schema not ready: %w", err)
	}

	repo := store.NewRepo(pool)
	// Anything left open by the previous process was cut short by whatever
	// stopped it; it cannot still be going now.
	if n, err := repo.MarkInterruptedRuns(ctx); err != nil {
		slog.WarnContext(ctx, "interrupted_runs_not_marked", "err", err.Error())
	} else if n > 0 {
		slog.InfoContext(ctx, "runs_marked_interrupted", "count", n)
	}
	fetcher := buildFetcher(cfg)
	normalizer := buildNormalizer(ctx, cfg)
	embedder := buildEmbedder(ctx, cfg)

	indexer := &index.Service{Fetcher: fetcher, Normalizer: normalizer, Repo: repo}
	searcher := &search.Service{Pool: pool}
	// Assigned only when non-nil: a nil pointer in an interface field is not a
	// nil interface, and every "is it configured" check downstream would pass.
	if embedder != nil {
		indexer.Embedder = embedder
		searcher.Embedder = embedder
	}
	parser := &parse.Service{Fetcher: fetcher, Normalizer: normalizer}
	crawler := &crawl.Service{
		Index:   indexer,
		Parse:   parser,
		Fetcher: fetcher,
		Repo:    repo,
	}

	deps := &Deps{
		Pool: pool,
		Handler: handler.NewRouter(handler.RouterDeps{
			Pool:             pool,
			Repo:             repo,
			Parse:            parser,
			Index:            indexer,
			Crawl:            crawler,
			Search:           searcher,
			SchedulerEnabled: cfg.SchedulerEnabled,
		}),
	}

	if cfg.SchedulerEnabled {
		deps.Scheduler = &crawl.Scheduler{
			Service:  crawler,
			Repo:     repo,
			Interval: cfg.ScheduleInterval,
			Limit:    cfg.SchedulerPageLimit,
		}
	} else {
		slog.InfoContext(ctx, "scheduler_disabled")
	}
	return deps, nil
}

// BuildParse assembles the single-URL dry run. It needs no database, so the CLI
// can use it too.
func BuildParse(ctx context.Context, cfg *config.Config) *parse.Service {
	return &parse.Service{
		Fetcher:    buildFetcher(cfg),
		Normalizer: buildNormalizer(ctx, cfg),
	}
}

func buildFetcher(cfg *config.Config) *fetch.Client {
	return fetch.New(fetch.Config{
		UserAgent:    cfg.UserAgent,
		DefaultDelay: cfg.DefaultCrawlDelay,
		Timeout:      cfg.RequestTimeout,
		MaxBody:      cfg.MaxBodyBytes,
	})
}

// buildNormalizer returns the live normalizer when a model is configured and
// the stub otherwise. Without a key the service still fetches, extracts and
// stores raw records — it just cannot say what any of them mean.
func buildNormalizer(ctx context.Context, cfg *config.Config) normalize.Normalizer {
	if ok, missing := cfg.NormalizerReady(); !ok {
		slog.WarnContext(ctx, "normalizer_stubbed", "missing", missing)
		return normalize.Stub{}
	}
	llm, err := normalize.NewLLM(normalize.LLMOptions{
		Endpoint: cfg.LLMBaseURL,
		APIKey:   cfg.LLMAPIKey,
		Model:    cfg.LLMModel,
	})
	if err != nil {
		slog.WarnContext(ctx, "normalizer_stubbed", "err", err.Error())
		return normalize.Stub{}
	}
	return llm
}

// buildEmbedder returns nil when embeddings are unconfigured. Items are still
// stored and still filterable; they are just not searchable by meaning.
func buildEmbedder(ctx context.Context, cfg *config.Config) *embed.Client {
	client, err := embed.New(embed.Options{
		BaseURL: cfg.LLMBaseURL,
		APIKey:  cfg.LLMAPIKey,
		Model:   cfg.EmbedModel,
		Dim:     cfg.EmbedDim,
	})
	if err != nil {
		slog.WarnContext(ctx, "embeddings_disabled", "err", err.Error())
		return nil
	}
	return client
}
