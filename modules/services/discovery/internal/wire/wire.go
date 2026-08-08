// Package wire is the composition root. Optional subsystems stay nil when they
// are unconfigured, and the service says so in the log rather than failing.
package wire

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/application/ask"
	"github.com/jiva-studio/shruti/discovery/internal/application/crawl"
	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/config"
	"github.com/jiva-studio/shruti/discovery/internal/handler"
	"github.com/jiva-studio/shruti/discovery/internal/infra/authjwt"
	"github.com/jiva-studio/shruti/discovery/internal/infra/embed"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/infra/ytdlp"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Deps is what a built service consists of.
type Deps struct {
	Pool      *pgxpool.Pool
	Handler   http.Handler
	Scheduler *crawl.Scheduler
	// Background holds the hand-triggered runs, which outlive the requests that
	// asked for them and have to be waited for at shutdown.
	Background *crawl.Background
	// Leader is the claim on being the process that crawls. Nil means another
	// replica holds it, and this one only serves.
	Leader *store.Leader
}

// Build connects the pool, applies the embedded migrations, and wires the
// router. It starts no crawl: the scheduler is returned rather than started,
// and boot must not touch anybody's website.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	pool, err := store.ConnectWith(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
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
	counters := metrics.New(time.Now().UTC())

	// One process crawls. See store.Lead for why: the per-host gap and the
	// breaker live in this process's memory, so a second crawler is a second
	// rate limiter and a doubled request rate at somebody else's site.
	leader, err := store.Lead(ctx, pool)
	if err != nil {
		pool.Close()
		return nil, err
	}
	if leader == nil {
		slog.InfoContext(ctx, "not_the_crawler", "reason", "another replica holds the lock")
	} else {
		// Anything left open by the previous process was cut short by whatever
		// stopped it; it cannot still be going now. Only the crawling process
		// may say so — a follower doing it would close the books on the runs
		// the leader has in flight.
		if n, err := repo.MarkInterruptedRuns(ctx); err != nil {
			slog.WarnContext(ctx, "interrupted_runs_not_marked", "err", err.Error())
		} else if n > 0 {
			slog.InfoContext(ctx, "runs_marked_interrupted", "count", n)
		}
	}
	fetcher := buildFetcher(cfg)
	normalizer := buildNormalizer(ctx, cfg)
	embedder := buildEmbedder(ctx, cfg)

	// Sources may carry their own extraction script. One that will not compile
	// is an error now rather than a surprise on the first page of a crawl.
	scripts, err := script.New()
	if err != nil {
		return nil, err
	}
	indexer := &index.Service{Fetcher: fetcher, Normalizer: normalizer, Repo: repo, Scripts: scripts, Metrics: counters}
	searcher := &search.Service{Pool: pool}
	// Assigned only when non-nil: a nil pointer in an interface field is not a
	// nil interface, and every "is it configured" check downstream would pass.
	if embedder != nil {
		indexer.Embedder = embedder
		searcher.Embedder = embedder
	}
	parser := &parse.Service{Fetcher: fetcher, Normalizer: normalizer}
	// Asking in words needs a model; asking with filters does not. Without a
	// key the question is still searched, as written.
	asker := &ask.Service{Searcher: searcher, Reader: buildQueryReader(ctx, cfg)}
	// The question's vector is wanted before the reading is finished, so the
	// two overlap rather than queue.
	if embedder != nil {
		asker.Embedder = embedder
	}
	crawler := &crawl.Service{
		Index:   indexer,
		Parse:   parser,
		Fetcher: fetcher,
		Repo:    repo,
	}

	// Admits callers to /discovery/search. A key that is set but unreadable is
	// louder than one that is absent: somebody meant to configure this and the
	// route will refuse either way, so say which it was.
	var verifier *authjwt.Verifier
	if cfg.AuthPublicKeyFile != "" {
		v, verr := authjwt.NewFromFile(cfg.AuthPublicKeyFile)
		if verr != nil {
			slog.ErrorContext(ctx, "auth_key_unusable", "path", cfg.AuthPublicKeyFile, "err", verr)
		}
		verifier = v
	} else {
		slog.WarnContext(ctx, "auth_key_unset", "effect", "/discovery/search will refuse every request")
	}

	background := crawl.NewBackground(crawler)
	deps := &Deps{
		Pool:       pool,
		Leader:     leader,
		Background: background,
		Handler: handler.NewRouter(handler.RouterDeps{
			Pool:             pool,
			Repo:             repo,
			Parse:            parser,
			Index:            indexer,
			Crawl:            background,
			Ask:              asker,
			Metrics:          counters,
			SchedulerEnabled: cfg.SchedulerEnabled,
			Verifier:         verifier,
		}),
	}

	switch {
	case !cfg.SchedulerEnabled:
		slog.InfoContext(ctx, "scheduler_disabled")
	case leader == nil:
		slog.InfoContext(ctx, "scheduler_disabled", "reason", "not the crawling replica")
	default:
		deps.Scheduler = crawl.NewScheduler(indexer, repo, fetcher, cfg.SchedulerWorkers, cfg.PageTimeout)
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
		Readers: []fetch.Reader{ytdlp.New(ytdlp.Options{
			UserAgent: cfg.UserAgent,
			Proxy:     cfg.Proxy,
			MaxBody:   cfg.MaxBodyBytes,
		})},
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

// buildQueryReader returns nil when no model is configured, and nil is a
// working service: a question nobody read is searched as it was written.
func buildQueryReader(ctx context.Context, cfg *config.Config) ask.Reader {
	if ok, missing := cfg.NormalizerReady(); !ok {
		slog.WarnContext(ctx, "questions_not_read", "missing", missing)
		return nil
	}
	reader, err := ask.NewLLM(ask.LLMOptions{
		Endpoint: cfg.LLMBaseURL, APIKey: cfg.LLMAPIKey, Model: cfg.QueryModel,
	})
	if err != nil {
		slog.WarnContext(ctx, "questions_not_read", "err", err.Error())
		return nil
	}
	return reader
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
