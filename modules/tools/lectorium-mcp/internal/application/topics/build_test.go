package topics

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	domaintopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/topics"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	outlineport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/outline"
)

// --- fakes -----------------------------------------------------------------

type fakeGranular struct{ entries []outlineport.GranularEntry }

func (f fakeGranular) ListGranular(context.Context) ([]outlineport.GranularRef, error) {
	return []outlineport.GranularRef{{TrackID: track.Id("t1"), Language: "en"}}, nil
}
func (f fakeGranular) ReadGranularOutline(context.Context, track.Id, string) ([]outlineport.GranularEntry, error) {
	return f.entries, nil
}

// fakeEmbed maps a title to one of two well-separated 2-D directions so k=2
// clustering is deterministic: "a*" → (1,0)-ish, anything else → (0,1)-ish.
type fakeEmbed struct{}

func (fakeEmbed) Model() string { return "test-embed" }
func (fakeEmbed) Dim() int      { return 2 }
func (fakeEmbed) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		if strings.HasPrefix(strings.ToLower(t), "a") {
			out[i] = []float32{1, float32(i) * 0.01}
		} else {
			out[i] = []float32{float32(i) * 0.01, 1}
		}
	}
	return out, nil
}

// fakeNamer fails its first `failures` calls, then succeeds. callCount is
// atomic so the parallel naming pass is race-free under -race.
type fakeNamer struct {
	failures  int32
	callCount int32
}

func (n *fakeNamer) NameCluster(_ context.Context, _, languages []string) (domaintopics.Names, error) {
	c := atomic.AddInt32(&n.callCount, 1)
	if c <= n.failures {
		return domaintopics.Names{}, fmt.Errorf("transient llm error")
	}
	full := map[string]string{}
	short := map[string]string{}
	for _, l := range languages {
		full[l] = "Name"
		short[l] = "N"
	}
	return domaintopics.Names{Full: full, Short: short}, nil
}

type fakeDict struct {
	mu    sync.Mutex
	count int
}

func (d *fakeDict) Create(context.Context, catalog.Kind, map[string]string, map[string]string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.count++
	return fmt.Sprintf("topic_%d", d.count), nil
}

type fakeVocab struct{ written bool }

func (v *fakeVocab) WriteVocabulary(context.Context, domaintopics.Vocabulary) error {
	v.written = true
	return nil
}

func sixHeadings() []outlineport.GranularEntry {
	titles := []string{"Apple one", "Apple two", "Apple three", "Banana one", "Banana two", "Banana three"}
	out := make([]outlineport.GranularEntry, len(titles))
	for i, t := range titles {
		out[i] = outlineport.GranularEntry{Title: t, Start: int64(i) * 1000, End: int64(i)*1000 + 500}
	}
	return out
}

func newBuild(namer ClusterNamer, dict DictMinter, vocab VocabWriter) BuildUseCase {
	return BuildUseCase{
		Granular:    fakeGranular{entries: sixHeadings()},
		Embed:       fakeEmbed{},
		Namer:       namer,
		Dict:        dict,
		Vocab:       vocab,
		K:           2,
		Iters:       10,
		Seed:        1,
		MaxDistance: 0.5,
		Samples:     3,
		NameRetries: 1, // no retry unless a test wants it
	}
}

// --- tests -----------------------------------------------------------------

// A naming failure must abort before any catalog write — no orphan topics, no
// vocabulary. (The whole point of naming before minting.)
func TestBuildAbortsCleanlyOnNamingFailure(t *testing.T) {
	namer := &fakeNamer{failures: 1000} // always fails
	dict := &fakeDict{}
	vocab := &fakeVocab{}
	_, err := newBuild(namer, dict, vocab).Run(context.Background())
	if err == nil {
		t.Fatal("expected an error when naming fails")
	}
	if dict.count != 0 {
		t.Fatalf("no topics should be created on naming failure, got %d", dict.count)
	}
	if vocab.written {
		t.Fatal("vocabulary must not be written on naming failure")
	}
}

func TestBuildCreatesTopicsAndWritesVocabulary(t *testing.T) {
	namer := &fakeNamer{}
	dict := &fakeDict{}
	vocab := &fakeVocab{}
	res, err := newBuild(namer, dict, vocab).Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Topics != 2 || dict.count != 2 {
		t.Fatalf("expected 2 topics created, got res=%d dict=%d", res.Topics, dict.count)
	}
	if !vocab.written {
		t.Fatal("vocabulary should be written on success")
	}
}

func TestBuildRetriesTransientNamingErrors(t *testing.T) {
	namer := &fakeNamer{failures: 1} // first call fails, retry succeeds
	dict := &fakeDict{}
	vocab := &fakeVocab{}
	b := newBuild(namer, dict, vocab)
	b.NameRetries = 3
	if _, err := b.Run(context.Background()); err != nil {
		t.Fatalf("retry should recover the transient failure, got %v", err)
	}
	if dict.count != 2 || !vocab.written {
		t.Fatalf("expected full build after retry, got dict=%d written=%v", dict.count, vocab.written)
	}
}
