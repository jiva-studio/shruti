package main

import (
	"context"
	"fmt"
	"os"

	reviewuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/review"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	pythonalign "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/align/python"
	reviewreg "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/review"
	throttledreview "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/review/throttled"
	geminibatch "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/reviewbatch/gemini"
	razdelsplit "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/sentencesplit/razdel"
	openaicompatreview "github.com/jiva-studio/lectorium/pipeline/review/openaicompat"
)

// Optional: without a script the review usecase falls back to LLM-derived
// sentence boundaries. A missing `pip install razdel` must not take the daemon
// down, so a failed spawn only disables the sidecar.
func buildSentenceSplitter(ctx context.Context, cfg config.SentencerOptions) *razdelsplit.Splitter {
	if cfg.ScriptPath == "" {
		return nil
	}
	s, err := razdelsplit.New(ctx, razdelsplit.Config{
		PythonBin:  cfg.PythonBin,
		ScriptPath: cfg.ScriptPath,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[sentencer] disabled: %v\n", err)
		return nil
	}
	return s
}

// Optional in the same way as the sentencer: without it review always takes
// the LLM path, even when a transcript.pdf is present.
func buildPDFAligner(ctx context.Context, cfg config.AlignPDFOptions) *pythonalign.Aligner {
	if cfg.ScriptPath == "" {
		return nil
	}
	a, err := pythonalign.New(ctx, pythonalign.Config{
		PythonBin:  cfg.PythonBin,
		ScriptPath: cfg.ScriptPath,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[align_pdf] disabled: %v\n", err)
		return nil
	}
	return a
}

// Every provider entry is one OpenAI-compatible upstream. Hybrid is built at
// call time by the registry when the caller passes 2 model aliases.
func buildReviewRegistry(cfg config.Review) (*reviewreg.Registry, error) {
	reg := reviewreg.New(cfg.Hybrid.Threshold, cfg.Hybrid.Expand, cfg.Hybrid.PremiumMinChars)
	for alias, p := range cfg.Providers {
		if p.APIKey == "" {
			fmt.Fprintf(os.Stderr, "[review] provider %q skipped: api_key is empty\n", alias)
			continue
		}
		reviewer, err := openaicompatreview.New(openaicompatreview.Config{
			NameAlias: alias,
			Endpoint:  p.Endpoint,
			APIKey:    p.APIKey,
			Model:     p.Model,
			MaxTokens: p.MaxTokens,
			Reasoning: p.Reasoning,
			Format:    openaicompatreview.Format(p.Format),
		})
		if err != nil {
			return nil, fmt.Errorf("review provider %q: %w", alias, err)
		}
		reg.Register(reviewer)
	}
	return reg, nil
}

// Batch review: half price, up to 24 hours. Nil when no api_key is configured,
// which keeps the tools registered but refusing.
func buildReviewBatcher(cfg config.ReviewBatchOptions) (reviewuc.Batcher, error) {
	if cfg.APIKey == "" {
		return nil, nil
	}
	b, err := geminibatch.New(geminibatch.Config{
		Endpoint:  cfg.Endpoint,
		APIKey:    cfg.APIKey,
		Model:     cfg.Model,
		MaxTokens: cfg.MaxTokens,
	})
	if err != nil {
		return nil, fmt.Errorf("review batch: %w", err)
	}
	fmt.Fprintf(os.Stderr, "[review] batch path enabled: %s\n", cfg.Model)
	return b, nil
}

// The cap applies across all worker-pool slots and all per-track review
// fan-out, preventing 429s when a batch run pushes hundreds of chunks
// back-to-back. The wrapper preserves Name(), so Register overwrites in place.
func throttleReviewers(reg *reviewreg.Registry, maxConcurrent int) {
	if maxConcurrent <= 0 {
		return
	}
	for _, name := range reg.List() {
		inner, ok := reg.Get(name)
		if !ok {
			continue
		}
		reg.Register(throttledreview.New(inner, maxConcurrent))
	}
}
