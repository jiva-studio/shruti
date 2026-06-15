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
		per := langWeights(entries, normalizeAll(vecs), centroids, topicIDs, minSim)
		mergeMax(merged, per)
	}
	if found == 0 {
		return AssignResult{TrackID: string(id), Skipped: true}, nil
	}

	final := topKFloorRenorm(merged, defaultTopK, defaultFloor)
	if err := uc.Catalog.SetTrackTopics(ctx, string(id), final); err != nil {
		return AssignResult{}, fmt.Errorf("write track topics: %w", err)
	}
	return AssignResult{TrackID: string(id), Topics: len(final)}, nil
}
