// Package topics builds the recommender's canonical topic vocabulary from
// granular outline artifacts (embed → cluster → name) and assigns weighted
// topics to tracks (nearest-centroid). Two use cases: BuildUseCase (one-time /
// on re-cluster) and AssignUseCase (per track, also for new tracks later).
package topics

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	domaintopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/topics"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	outlineport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/outline"
)

// Embedder turns texts into dense vectors (one per text, same order).
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Dim() int
}

// GranularReader reads one track-language's granular outline. Returns an
// os.ErrNotExist-wrapped error when the artifact is absent.
type GranularReader interface {
	ReadGranularOutline(ctx context.Context, id track.Id, language string) ([]outlineport.GranularEntry, error)
}

// GranularLister enumerates every granular artifact in the lake.
type GranularLister interface {
	ListGranular(ctx context.Context) ([]outlineport.GranularRef, error)
}

// CatalogWriter replaces a track's full topic membership.
type CatalogWriter interface {
	SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error
}

// DictMinter mints a topic dict entry (one row per locale) and returns its id.
type DictMinter interface {
	Create(ctx context.Context, kind catalog.Kind, names, shortNames map[string]string) (string, error)
}

// ClusterNamer names one cluster of headings in ru + en (offline LLM call).
type ClusterNamer interface {
	NameCluster(ctx context.Context, sampleTitles []string) (nameRu, nameEn string, err error)
}

// VocabReader / VocabWriter persist the centroid vocabulary artifact.
type VocabReader interface {
	ReadVocabulary() (domaintopics.Vocabulary, error)
}
type VocabWriter interface {
	WriteVocabulary(ctx context.Context, v domaintopics.Vocabulary) error
}

// centroidVectors splits a vocabulary into parallel (normalized centroid,
// topic_id) slices for nearest-topic matching.
func centroidVectors(v domaintopics.Vocabulary) ([][]float32, []string) {
	vecs := make([][]float32, len(v.Centroids))
	ids := make([]string, len(v.Centroids))
	for i, c := range v.Centroids {
		vecs[i] = normalize(c.Vector)
		ids[i] = c.TopicID
	}
	return vecs, ids
}

func normalizeAll(vecs [][]float32) [][]float32 {
	out := make([][]float32, len(vecs))
	for i, v := range vecs {
		out[i] = normalize(v)
	}
	return out
}
