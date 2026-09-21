package main

import (
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	openaicompatattribtranslate "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/attributiontranslate/openaicompat"
	resolverchain "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/chain"
	exactresolver "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/exact"
	openaicompatresolver "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/openaicompat"
	openaicompattranslate "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/dicttranslate/openaicompat"
	openaicompatmeta "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/openaicompat"
	openaicompattitle "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/title/openaicompat"
)

// Same model-naming convention as the review providers (e.g. anthropic/claude-sonnet-4.6).
func buildMetadataExtractor(cfg config.Metadata) (*openaicompatmeta.Extractor, error) {
	e, err := openaicompatmeta.New(openaicompatmeta.Config{
		Endpoint:   cfg.Endpoint,
		APIKey:     cfg.APIKey,
		Model:      cfg.Model,
		MaxTokens:  cfg.MaxTokens,
		PromptPath: cfg.PromptPath,
	})
	if err != nil {
		return nil, fmt.Errorf("metadata extractor: %w", err)
	}
	return e, nil
}

// Chain order is exact (cheap) → LLM; the catalog opens lazily.
func buildResolverChain(alias string, p config.ProviderOptions, currentDBPath string) (*resolverchain.Chain, error) {
	llm, err := openaicompatresolver.New(openaicompatresolver.Config{
		NameAlias:  alias,
		Endpoint:   p.Endpoint,
		APIKey:     p.APIKey,
		Model:      p.Model,
		MaxTokens:  p.MaxTokens,
		PromptPath: p.PromptPath,
	})
	if err != nil {
		return nil, fmt.Errorf("llm resolver: %w", err)
	}
	return resolverchain.New(exactresolver.NewLazy(currentDBPath), llm), nil
}

// Reuses the resolver model: Haiku-class is plenty for short-form
// transliteration of new dict entries.
func buildDictTranslator(p config.ProviderOptions) (*openaicompattranslate.Translator, error) {
	t, err := openaicompattranslate.New(openaicompattranslate.Config{
		Endpoint:  p.Endpoint,
		APIKey:    p.APIKey,
		Model:     p.Model,
		MaxTokens: 256,
	})
	if err != nil {
		return nil, fmt.Errorf("dict translator: %w", err)
	}
	return t, nil
}

func buildTitleExtractor(p config.ProviderOptions) (*openaicompattitle.Extractor, error) {
	t, err := openaicompattitle.New(openaicompattitle.Config{
		Endpoint:  p.Endpoint,
		APIKey:    p.APIKey,
		Model:     p.Model,
		MaxTokens: 64,
	})
	if err != nil {
		return nil, fmt.Errorf("title extractor: %w", err)
	}
	return t, nil
}

func buildAttributionTranslator(p config.ProviderOptions) (*openaicompatattribtranslate.Translator, error) {
	t, err := openaicompatattribtranslate.New(openaicompatattribtranslate.Config{
		Endpoint:  p.Endpoint,
		APIKey:    p.APIKey,
		Model:     p.Model,
		MaxTokens: 200,
	})
	if err != nil {
		return nil, fmt.Errorf("attribution translator: %w", err)
	}
	return t, nil
}
