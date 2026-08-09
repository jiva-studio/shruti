package topics

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

// AssignUseCase assigns weighted topics to one track by matching its outline
// headings to the canonical topic centroids. Reused for the bulk pass
// (pipeline.run op=topics) and for each new track later.
type AssignUseCase struct {
	Embed    Embedder
	Granular GranularReader
	Vocab    VocabReader
	Catalog  CatalogWriter
	// Langs are the languages whose granular outline is tried (e.g. ru, en).
	Langs []string
	// TopK caps how many topics a track carries and Floor drops the ones that
	// barely register. Zero leaves the package defaults in place.
	TopK  int
	Floor float64
}

func (uc AssignUseCase) topK() int {
	if uc.TopK > 0 {
		return uc.TopK
	}
	return defaultTopK
}

func (uc AssignUseCase) floor() float64 {
	if uc.Floor > 0 {
		return uc.Floor
	}
	return defaultFloor
}

type AssignResult struct {
	TrackID string `json:"trackId"`
	Topics  int    `json:"topics"`
	Skipped bool   `json:"skipped"` // true when the track has no granular outline
}

func (uc AssignUseCase) Run(ctx context.Context, id track.Id) (AssignResult, error) {
	voc, err := uc.Vocab.ReadVocabulary()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return AssignResult{}, fmt.Errorf("no topic vocabulary yet — run topics.build first")
		}
		return AssignResult{}, fmt.Errorf("read vocabulary: %w", err)
	}
	if len(voc.Centroids) == 0 {
		return AssignResult{}, fmt.Errorf("topic vocabulary is empty — run topics.build first")
	}
	// The vocabulary's centroids live in the embedding space of the model that
	// built it. Assigning with a different model silently dot-products vectors
	// from two spaces over their shorter prefix — plausible but meaningless
	// topics, no error. Refuse it: a config drift means rebuild the vocabulary.
	if voc.EmbedModel != "" && voc.EmbedModel != uc.Embed.Model() {
		return AssignResult{}, fmt.Errorf(
			"vocabulary built with embedding model %q but assign configured for %q — rebuild with topics.build",
			voc.EmbedModel, uc.Embed.Model())
	}
	centroids, topicIDs := centroidVectors(voc)
	minSim := 1 - voc.MaxDistance

	merged := map[string]float64{}
	found := 0
	for _, lang := range uc.Langs {
		entries, err := uc.Granular.ReadGranularOutline(ctx, id, lang)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return AssignResult{}, fmt.Errorf("read granular %s/%s: %w", id, lang, err)
		}
		if len(entries) == 0 {
			continue
		}
		found++
		titles := make([]string, len(entries))
		for i, e := range entries {
			titles[i] = e.Title
		}
		vecs, err := uc.Embed.Embed(ctx, titles)
		if err != nil {
			return AssignResult{}, fmt.Errorf("embed %s/%s: %w", id, lang, err)
		}
		if len(vecs) > 0 && len(vecs[0]) != voc.Dim {
			return AssignResult{}, fmt.Errorf(
				"embedding dimension %d does not match vocabulary dimension %d — rebuild with topics.build",
				len(vecs[0]), voc.Dim)
		}
		per := langWeights(entries, normalizeAll(vecs), centroids, topicIDs, minSim)
		mergeMax(merged, per)
	}
	if found == 0 {
		return AssignResult{TrackID: string(id), Skipped: true}, nil
	}

	final := topKFloorRenorm(merged, uc.topK(), uc.floor())
	if err := uc.Catalog.SetTrackTopics(ctx, string(id), final); err != nil {
		return AssignResult{}, fmt.Errorf("write track topics: %w", err)
	}
	return AssignResult{TrackID: string(id), Topics: len(final)}, nil
}
