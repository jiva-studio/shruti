// Package topics builds the recommender's canonical topic vocabulary from
// granular outline artifacts (embed → cluster → name) and assigns weighted
// topics to tracks (nearest-centroid). Two use cases: BuildUseCase (one-time /
// on re-cluster) and AssignUseCase (per track, also for new tracks later).
package topics

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	domaintopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/topics"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	outlineport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/outline"
)

// Embedder turns texts into dense vectors (one per text, same order). Model
// identifies the embedding model so a vocabulary records which space it lives
// in and the assign step can refuse a mismatched configuration.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Dim() int
	Model() string
}

// GranularReader reads one track-language's granular outline. Returns an
// os.ErrNotExist-wrapped error when the artifact is absent.
type GranularReader interface {
	ReadGranularOutline(ctx context.Context, id track.ID, language string) ([]outlineport.GranularEntry, error)
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

// ClusterNamer names one cluster of headings (full + short) in each requested
// language (offline LLM call). Languages are passed in, not assumed.
type ClusterNamer interface {
	NameCluster(ctx context.Context, sampleTitles, languages []string) (domaintopics.Names, error)
}

// HeadingVectorStore keeps every distinct heading with its embedding between
// builds. Read returns an os.ErrNotExist-wrapped error when nothing is cached.
type HeadingVectorStore interface {
	ReadHeadingVectors() (domaintopics.HeadingVectors, error)
	WriteHeadingVectors(ctx context.Context, v domaintopics.HeadingVectors) error
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
