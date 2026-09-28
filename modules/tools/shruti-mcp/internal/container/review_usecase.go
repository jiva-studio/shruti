package container

import (
	"log"
	"os"

	alignpdfuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/align"
	reviewuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/review"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	pythonalign "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/align/python"
	sqliteregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/lakeregistry/sqlite"
	reviewreg "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/review"
	fsbatchstore "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/reviewbatch/fs"
	razdelsplit "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sentencesplit/razdel"
	fstranscript "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/transcriptstore/fs"
	alignport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/align"
	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
	glossary "github.com/jiva-studio/shruti/pipeline/glossary"
	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	"github.com/jiva-studio/shruti/pipeline/ports/sentencesplit"
)

func buildReviewUseCase(
	cfg *config.Config,
	registry *sqliteregistry.Registry,
	transcripts *fstranscript.Store,
	reviewers *reviewreg.Registry,
	splitter *razdelsplit.Splitter,
	aligner *pythonalign.Aligner,
	alignPDF *alignpdfuc.UseCase,
	gloss *glossary.Glossary,
	batcher reviewuc.Batcher,
	batchJobs *fsbatchstore.Store,
	clock clockport.Clock,
) reviewuc.UseCase {
	rc := cfg.Review
	return reviewuc.UseCase{
		Registry:    registry,
		Transcripts: transcripts,
		Reviewers:   reviewers,
		Splitter:    splitterOrNil(splitter),
		Align:       alignPDFOrNil(aligner, alignPDF),
		OutDir:      cfg.Out,
		DefaultAttemptsFor: func(language string) []reviewuc.Attempt {
			src := rc.DefaultReviewAttempts(language)
			out := make([]reviewuc.Attempt, len(src))
			for i, a := range src {
				out[i] = reviewuc.Attempt{
					Models:          a.Models,
					Threshold:       a.Threshold,
					Expand:          a.Expand,
					PremiumMinChars: a.PremiumMinChars,
				}
			}
			return out
		},
		ChunkSize:            rc.ChunkSize,
		Overlap:              rc.Overlap,
		Retries:              rc.Retries,
		Concurrency:          rc.Concurrency,
		LowConfThreshold:     rc.Hybrid.Threshold,
		NoiseFilterThreshold: rc.NoiseFilterThreshold,
		Glossary:             glossaryOrNil(gloss),
		Batch:                batcher,
		BatchJobs:            batchJobs,
		BatchModel:           rc.Batch.Model,
		BatchMaxTokens:       rc.Batch.MaxTokens,
		BatchPriceIn:         rc.Batch.InputPerMillion,
		BatchPriceOut:        rc.Batch.OutputPerMillion,
		GlossaryThreshold:    rc.Glossary.MatchThreshold,
		GlossaryMaxHints:     rc.Glossary.MaxHintsPerChunk,
		Clock:                clock,
	}
}

// The *OrNil helpers turn a nil concrete pointer into a nil interface. Passed
// straight into an interface field, a nil pointer makes a non-nil interface,
// the use case's nil check passes, and the first call panics on the nil
// receiver.

func splitterOrNil(s *razdelsplit.Splitter) sentencesplit.Splitter {
	if s == nil {
		return nil
	}
	return s
}

// alignPDFOrNil hands review the PDF alignment use case only when the aligner
// sidecar started; without it review always takes the LLM path.
func alignPDFOrNil(a *pythonalign.Aligner, uc *alignpdfuc.UseCase) *alignpdfuc.UseCase {
	if a == nil {
		return nil
	}
	return uc
}

func alignerOrNil(a *pythonalign.Aligner) alignport.Aligner {
	if a == nil {
		return nil
	}
	return a
}

func glossaryOrNil(g *glossary.Glossary) glossaryport.Matcher {
	if g == nil {
		return nil
	}
	return g
}

// loadGlossaryOrNil returns the review glossary: the operator's YAML at
// override when it parses, otherwise the curated dictionary embedded in the
// glossary package. It is nil only when even that fails to parse, and review
// then runs without hints.
func loadGlossaryOrNil(override string) *glossary.Glossary {
	if override != "" {
		body, err := os.ReadFile(override)
		switch {
		case err != nil:
			log.Printf("[review] glossary override unreadable, using embedded: %v", err)
		default:
			g, err := glossary.Parse(body)
			if err == nil {
				log.Printf("[review] glossary loaded: %d entries from %s", len(g.Entries), override)
				return g
			}
			log.Printf("[review] glossary override parse failed, using embedded: %v", err)
		}
	}
	g, err := glossary.Embedded()
	if err != nil {
		log.Printf("[review] glossary disabled: %v", err)
		return nil
	}
	log.Printf("[review] glossary loaded: %d embedded entries", len(g.Entries))
	return g
}
