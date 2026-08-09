package topics

import (
	"context"
	"os"
	"testing"

	domaintopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/topics"
)

type countingEmbedder struct {
	model string
	dim   int
	calls [][]string
}

func (e *countingEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	e.calls = append(e.calls, append([]string(nil), texts...))
	out := make([][]float32, len(texts))
	for i, t := range texts {
		out[i] = []float32{float32(len(t)), 1}
	}
	return out, nil
}
func (e *countingEmbedder) Dim() int      { return e.dim }
func (e *countingEmbedder) Model() string { return e.model }

type memVectors struct {
	stored *domaintopics.HeadingVectors
}

func (m *memVectors) ReadHeadingVectors() (domaintopics.HeadingVectors, error) {
	if m.stored == nil {
		return domaintopics.HeadingVectors{}, os.ErrNotExist
	}
	return *m.stored, nil
}

func (m *memVectors) WriteHeadingVectors(_ context.Context, v domaintopics.HeadingVectors) error {
	cp := v
	m.stored = &cp
	return nil
}

// Embedding is the whole cost of a build, so a second build over the same
// corpus must pay for nothing — that is what makes trying another k affordable.
func TestVectorsFor_ReusesTheCacheAndEmbedsOnlyWhatIsNew(t *testing.T) {
	emb := &countingEmbedder{model: "m", dim: 2}
	store := &memVectors{}
	uc := BuildUseCase{Embed: emb, Vectors: store}

	if _, n, err := uc.vectorsFor(context.Background(), []string{"a", "bb"}); err != nil || n != 2 {
		t.Fatalf("first build: embedded %d, err %v — want 2", n, err)
	}
	if _, n, err := uc.vectorsFor(context.Background(), []string{"a", "bb"}); err != nil || n != 0 {
		t.Fatalf("re-cluster: embedded %d, err %v — want 0", n, err)
	}
	vecs, n, err := uc.vectorsFor(context.Background(), []string{"a", "bb", "ccc"})
	if err != nil || n != 1 {
		t.Fatalf("one new heading: embedded %d, err %v — want 1", n, err)
	}
	if len(vecs) != 3 || vecs[2][0] != 3 {
		t.Fatalf("vectors do not line up with the titles: %v", vecs)
	}
	if got := emb.calls[len(emb.calls)-1]; len(got) != 1 || got[0] != "ccc" {
		t.Fatalf("the last call re-embedded more than the new heading: %v", got)
	}
}

// Vectors from two models share no space; mixing them clusters into something
// plausible and wrong, with nothing to notice it. The cache is dropped instead.
func TestVectorsFor_DiscardsACacheFromAnotherModel(t *testing.T) {
	store := &memVectors{stored: &domaintopics.HeadingVectors{
		Model: "old", Dim: 2, Titles: []string{"a"}, Vectors: [][]float32{{9, 9}},
	}}
	emb := &countingEmbedder{model: "new", dim: 2}
	uc := BuildUseCase{Embed: emb, Vectors: store}

	vecs, n, err := uc.vectorsFor(context.Background(), []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("embedded %d — the stale cache was reused", n)
	}
	if vecs[0][0] == 9 {
		t.Fatal("the vector came from the other model's cache")
	}
}
