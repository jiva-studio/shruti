// Package wire is the ingest worker's composition root: it assembles the fetch
// / transcribe / review / store adapters, the runingest pipeline use case, the
// Redis-Streams `ingest.work` consumer, and the `ingest.result` publisher from
// a validated Config, keeping cmd/ingest thin.
//
// The worker is stateless — there is NO Postgres pool, no migrations, and no
// outbox relay. When the streams broker (or a pipeline prerequisite) is not
// configured the service still serves HTTP so health probes pass.
package wire

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/shruti/ingest/internal/application/runingest"
	"github.com/jiva-studio/shruti/ingest/internal/config"
	"github.com/jiva-studio/shruti/ingest/internal/domain/ingest"
	"github.com/jiva-studio/shruti/ingest/internal/handler"
	"github.com/jiva-studio/shruti/ingest/internal/infra/blob/bunny"
	blobs3 "github.com/jiva-studio/shruti/ingest/internal/infra/blob/s3"
	"github.com/jiva-studio/shruti/ingest/internal/infra/events/redisstream"
	"github.com/jiva-studio/shruti/ingest/internal/infra/fetch/ytdlp"
	"github.com/jiva-studio/shruti/ingest/internal/infra/review"
	"github.com/jiva-studio/shruti/ingest/internal/infra/transcribe/deepgram"
	"github.com/jiva-studio/shruti/ingest/internal/ports"
	glossary "github.com/jiva-studio/shruti/pipeline/glossary"
	"github.com/jiva-studio/shruti/pipeline/metadata"
	openaicompatmeta "github.com/jiva-studio/shruti/pipeline/metadata/openaicompat"
	openaicompatoutline "github.com/jiva-studio/shruti/pipeline/outline/openaicompat"
	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	outlineport "github.com/jiva-studio/shruti/pipeline/ports/outline"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	translateport "github.com/jiva-studio/shruti/pipeline/ports/translate"
	hybrid "github.com/jiva-studio/shruti/pipeline/review/hybrid"
	openaicompatreview "github.com/jiva-studio/shruti/pipeline/review/openaicompat"
	openaicompattranslate "github.com/jiva-studio/shruti/pipeline/translate/openaicompat"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Redis and must close it on shutdown. Consumer is nil when the
// streams broker (or a pipeline prerequisite) is not configured — the service
// still serves HTTP in that case.
type Deps struct {
	Redis    *redis.Client
	Handler  http.Handler
	Consumer *redisstream.Consumer
}

// Build wires the HTTP router and — when configured — the `ingest.work`
// consumer plus its pipeline. On any failure it closes whatever it opened.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	deps := &Deps{
		Handler: handler.NewRouter(handler.RouterDeps{}),
	}

	// The broker is optional: without STREAMS_REDIS_URL the service is
	// HTTP-only (health/readiness), which keeps local/dev boots trivial.
	if cfg.StreamsRedisURL == "" {
		slog.WarnContext(ctx, "streams_disabled", "reason", "STREAMS_REDIS_URL unset")
		return deps, nil
	}

	rdb, err := redisstream.Connect(ctx, cfg.StreamsRedisURL)
	if err != nil {
		return nil, fmt.Errorf("connect streams: %w", err)
	}
	deps.Redis = rdb

	// The consumer only starts when every pipeline prerequisite is present;
	// otherwise a consumed message would fail with a misconfiguration.
	svc, ready, missing := buildPipeline(ctx, cfg, rdb)
	if !ready {
		slog.WarnContext(ctx, "ingest_consumer_disabled", "missing", missing)
		return deps, nil
	}
	deps.Consumer = redisstream.NewConsumer(rdb, cfg.WorkStream, cfg.ConsumerGroup, cfg.ConsumerName, svc)
	return deps, nil
}

// buildPipeline assembles the runingest use case. ready is false (with the list
// of missing config keys) when a required credential is absent.
func buildPipeline(ctx context.Context, cfg *config.Config, rdb *redis.Client) (*runingest.Service, bool, []string) {
	var missing []string
	if cfg.DeepgramAPIKey == "" {
		missing = append(missing, "DEEPGRAM_API_KEY")
	}

	// The blob store MUST target the same backend the public CDN serves from, or
	// the app/chat can't fetch the audio + transcript. "bunny" (global) writes to
	// Bunny Edge Storage over its HTTP API; "s3" (RU proxy / dev) uses the AWS SDK
	// against AWS or an S3-compatible endpoint (Yandex).
	blob, blobMissing := buildBlob(ctx, cfg)
	missing = append(missing, blobMissing...)
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
		Fetcher:     fetcher,
		Transcriber: deepgram.New(cfg.DeepgramAPIKey, cfg.DeepgramModel),
		Reviewer:    review.New(),
		Blob:        blob,
		Results:     resultAdapter{redisstream.NewResultPublisher(rdb, cfg.ResultStream, cfg.StreamMaxLen)},
		Extractor:   buildExtractor(ctx, cfg),
		LLMReviewer: buildReviewer(ctx, cfg),
		Outliner:    buildOutliner(ctx, cfg),
		Translator:  buildTranslator(ctx, cfg),
		Prober:      fetcher,
		Glossary:    buildGlossary(ctx),
		JobTimeout:  cfg.JobTimeout,
	})
	return svc, true, nil
}

// buildBlob selects the content-addressed store by STORAGE_BACKEND. It returns
// the list of missing config keys (so the caller can report a single
// "consumer disabled" reason) instead of an error, and a nil store when a
// required credential is absent.
func buildBlob(ctx context.Context, cfg *config.Config) (ports.BlobStore, []string) {
	switch strings.ToLower(cfg.StorageBackend) {
	case "bunny":
		var missing []string
		if cfg.StorageZone == "" {
			missing = append(missing, "STORAGE_ZONE")
		}
		if cfg.StorageKey == "" {
			missing = append(missing, "STORAGE_KEY")
		}
		if len(missing) > 0 {
			return nil, missing
		}
		store, err := bunny.New(cfg.StorageZone, cfg.StorageEndpoint, cfg.StorageKey)
		if err != nil {
			return nil, []string{"bunny(config)"}
		}
		return store, nil
	default: // "s3" (and any unset value)
		if cfg.S3Bucket == "" {
			return nil, []string{"S3_BUCKET"}
		}
		store, err := blobs3.New(ctx, cfg.S3Bucket, cfg.S3Region, cfg.S3Endpoint)
		if err != nil {
			return nil, []string{"S3(config)"}
		}
		return store, nil
	}
}

// buildExtractor builds the shared LLM metadata extractor; nil (→ raw title
// only) when unconfigured or on error.
func buildExtractor(ctx context.Context, cfg *config.Config) metadata.Extractor {
	if cfg.MetadataLLMAPIKey == "" || cfg.MetadataLLMModel == "" {
		slog.WarnContext(ctx, "ingest_extractor_disabled",
			"reason", "METADATA_LLM_API_KEY / METADATA_LLM_MODEL unset")
		return nil
	}
	ex, err := openaicompatmeta.New(openaicompatmeta.Config{
		Endpoint: cfg.MetadataLLMEndpoint,
		APIKey:   cfg.MetadataLLMAPIKey,
		Model:    cfg.MetadataLLMModel,
	})
	if err != nil {
		slog.WarnContext(ctx, "ingest_extractor_disabled", "error", err.Error())
		return nil
	}
	return ex
}

// buildReviewer composes the same baseline + premium hybrid the corpus tool
// uses; nil (→ deterministic normalize) when unconfigured or on error.
func buildReviewer(ctx context.Context, cfg *config.Config) reviewport.Reviewer {
	if cfg.ReviewLLMAPIKey == "" || cfg.ReviewLLMBaseline == "" {
		slog.WarnContext(ctx, "ingest_reviewer_disabled",
			"reason", "REVIEW_LLM_API_KEY / REVIEW_LLM_BASELINE unset")
		return nil
	}
	mk := func(model string) (reviewport.Reviewer, error) {
		return openaicompatreview.New(openaicompatreview.Config{
			NameAlias: model,
			Endpoint:  cfg.ReviewLLMEndpoint,
			APIKey:    cfg.ReviewLLMAPIKey,
			Model:     model,
			Reasoning: cfg.ReviewLLMReasoning,
		})
	}
	chain := make([]reviewport.Reviewer, 0, 1+len(cfg.ReviewLLMPremium))
	for _, model := range append([]string{cfg.ReviewLLMBaseline}, cfg.ReviewLLMPremium...) {
		rv, err := mk(model)
		if err != nil {
			slog.WarnContext(ctx, "ingest_reviewer_disabled", "model", model, "error", err.Error())
			return nil
		}
		chain = append(chain, rv)
	}
	if len(chain) == 1 {
		return chain[0]
	}
	return hybrid.New(chain, 0.70, 1, 8) // threshold, expand, premium_min_chars — corpus defaults
}

// buildOutliner builds the shared LLM outline + description generator; nil (→
// no outline/description) when unconfigured or on error.
func buildOutliner(ctx context.Context, cfg *config.Config) outlineport.Generator {
	if cfg.OutlineLLMAPIKey == "" || cfg.OutlineLLMModel == "" {
		slog.WarnContext(ctx, "ingest_outliner_disabled",
			"reason", "OUTLINE_LLM_API_KEY / OUTLINE_LLM_MODEL unset")
		return nil
	}
	gen, err := openaicompatoutline.New(openaicompatoutline.Config{
		Endpoint:  cfg.OutlineLLMEndpoint,
		APIKey:    cfg.OutlineLLMAPIKey,
		Model:     cfg.OutlineLLMModel,
		MaxTokens: cfg.OutlineLLMMaxTokens,
		Reasoning: cfg.OutlineLLMReasoning,
	})
	if err != nil {
		slog.WarnContext(ctx, "ingest_outliner_disabled", "error", err.Error())
		return nil
	}
	return gen
}

// buildTranslator builds the shared LLM title translator, reusing the outline
// LLM credentials (same OpenRouter model); nil (→ variants keep the source
// title) when unconfigured or on error.
func buildTranslator(ctx context.Context, cfg *config.Config) translateport.Translator {
	// Prefer the dedicated translation model (TRANSLATE_LLM_*) so translation can
	// use a different Gemini model than outline; fall back to the outline LLM so a
	// default deploy still translates.
	endpoint, apiKey, model, reasoning := cfg.TranslateLLMEndpoint, cfg.TranslateLLMAPIKey, cfg.TranslateLLMModel, cfg.TranslateLLMReasoning
	source := "TRANSLATE_LLM_*"
	if apiKey == "" || model == "" {
		endpoint, apiKey, model, reasoning = cfg.OutlineLLMEndpoint, cfg.OutlineLLMAPIKey, cfg.OutlineLLMModel, cfg.OutlineLLMReasoning
		source = "OUTLINE_LLM_* (fallback)"
	}
	if apiKey == "" || model == "" {
		slog.WarnContext(ctx, "ingest_translator_disabled",
			"reason", "neither TRANSLATE_LLM_* nor OUTLINE_LLM_* configured")
		return nil
	}
	tr, err := openaicompattranslate.New(openaicompattranslate.Config{
		Endpoint:  endpoint,
		APIKey:    apiKey,
		Model:     model,
		Reasoning: reasoning,
	})
	if err != nil {
		slog.WarnContext(ctx, "ingest_translator_disabled", "error", err.Error())
		return nil
	}
	slog.InfoContext(ctx, "ingest_translator_enabled", "config", source, "model", model)
	return tr
}

// buildGlossary builds the shared review glossary from its embedded dictionary;
// nil (→ review runs without term hints) only if the embedded data fails.
func buildGlossary(ctx context.Context) glossaryport.Matcher {
	g, err := glossary.Embedded()
	if err != nil {
		slog.WarnContext(ctx, "ingest_glossary_disabled", "error", err.Error())
		return nil
	}
	return g
}

// resultAdapter bridges the domain-facing ports.ResultPublisher to the
// transport-facing redisstream publisher, marshalling the result across the
// boundary so neither package imports the other.
type resultAdapter struct{ pub *redisstream.ResultPublisher }

func (a resultAdapter) Publish(ctx context.Context, r ingest.Result) error {
	b, err := r.Marshal()
	if err != nil {
		return err
	}
	return a.pub.Publish(ctx, b)
}
