package main

import (
	"log"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/dictcrud"
	topicsapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/topics"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	sqlitecatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite"
	openaicompatembed "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/embed/openaicompat"
	fsoutline "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/outline/fs"
	fstopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/topics/fs"
	openaicompattopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/topics/openaicompat"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/tools"
)

// A text-embeddings client plus an LLM cluster namer, both gated on
// embed.api_key and the outline LLM config. A misconfigured client (e.g.
// embed.model unset) disables only the topic tools, never the whole server.
func buildTopicsDeps(
	cfg *config.Config,
	granular *fsoutline.Store,
	centroids *fstopics.Store,
	dict dictcrud.UseCase,
	currentDBPath string,
) tools.TopicsDeps {
	deps := tools.TopicsDeps{Catalog: sqlitecatalog.NewLazy(currentDBPath)}
	if cfg.Embed.APIKey == "" || cfg.Outline.APIKey == "" {
		return deps
	}

	embedClient, embErr := openaicompatembed.New(openaicompatembed.Config{
		Endpoint:   cfg.Embed.Endpoint,
		APIKey:     cfg.Embed.APIKey,
		Model:      cfg.Embed.Model,
		Dimensions: cfg.Embed.Dimensions,
		BatchSize:  cfg.Embed.BatchSize,
	})
	// Cluster naming reuses the outline LLM (Flash-Lite class).
	var topicNamer *openaicompattopics.Namer
	var namerErr error
	if embErr == nil {
		topicNamer, namerErr = openaicompattopics.New(openaicompattopics.Config{
			Endpoint:  cfg.Outline.Endpoint,
			APIKey:    cfg.Outline.APIKey,
			Model:     cfg.Outline.Model,
			MaxTokens: 200,
			Reasoning: cfg.Outline.Reasoning,
		})
	}
	switch {
	case embErr != nil:
		log.Printf("topic recommender disabled: embeddings client: %v", embErr)
	case namerErr != nil:
		log.Printf("topic recommender disabled: topic namer: %v", namerErr)
	default:
		deps.Build = topicsapp.BuildUseCase{
			Granular:    granular,
			Embed:       embedClient,
			Namer:       topicNamer,
			Dict:        dict,
			Vocab:       centroids,
			Vectors:     centroids,
			K:           cfg.Topics.K,
			Iters:       cfg.Topics.Iters,
			Seed:        cfg.Topics.Seed,
			MaxDistance: cfg.Topics.MaxDistance,
			Samples:     cfg.Topics.Samples,
		}
		deps.Assign = topicsapp.AssignUseCase{
			Embed:    embedClient,
			Granular: granular,
			Vocab:    centroids,
			Catalog:  sqlitecatalog.NewLazy(currentDBPath),
			Langs:    []string{"ru", "en"},
			TopK:     cfg.Topics.TopK,
			Floor:    cfg.Topics.Floor,
		}
	}
	return deps
}
