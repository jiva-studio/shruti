package main

import (
	"fmt"
	"log"

	outlineuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/outline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	geminioutlinebatch "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/outlinebatch/gemini"
	pipelineoutline "github.com/jiva-studio/lectorium/pipeline/outline"
	openaicompatoutline "github.com/jiva-studio/lectorium/pipeline/outline/openaicompat"
	outlineport "github.com/jiva-studio/lectorium/pipeline/ports/outline"
)

// Nil disables track.transcript.outline / pipeline.run op=outline.
func buildOutlineGenerator(cfg config.Outline) (outlineport.Generator, error) {
	if cfg.APIKey == "" {
		return nil, nil
	}
	g, err := openaicompatoutline.New(openaicompatoutline.Config{
		Endpoint:  cfg.Endpoint,
		APIKey:    cfg.APIKey,
		Model:     cfg.Model,
		MaxTokens: cfg.MaxTokens,
		Reasoning: cfg.Reasoning,
	})
	if err != nil {
		return nil, fmt.Errorf("outline generator: %w", err)
	}
	return g, nil
}

func resolveOutlineCompressor(mode string) (pipelineoutline.Compressor, error) {
	c, ok := pipelineoutline.CompressorByName(mode)
	if !ok {
		return nil, fmt.Errorf("outline.compress: unknown mode %q (none | punctuation)", mode)
	}
	return c, nil
}

// Half-price outline path. Configured separately from the synchronous one
// because the batch protocol is Gemini's own, not part of the
// OpenAI-compatible surface the sync client speaks.
func buildOutlineBatcher(cfg config.OutlineBatch) (outlineuc.Batcher, error) {
	if cfg.APIKey == "" {
		return nil, nil
	}
	b, err := geminioutlinebatch.New(geminioutlinebatch.Config{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
		Model:    cfg.Model,
	})
	if err != nil {
		return nil, fmt.Errorf("outline batch: %w", err)
	}
	log.Printf("[outline] batch path enabled: %s", cfg.Model)
	return b, nil
}
