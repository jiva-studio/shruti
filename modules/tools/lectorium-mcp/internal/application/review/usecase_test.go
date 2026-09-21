package review

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	fsartifact "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/artifact/fs"
	systemclock "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/clock"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/ids/nanoid"
	sqliteregistry "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/lakeregistry/sqlite"
	reviewreg "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/review"
	fstranscript "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/transcriptstore/fs"
	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// fakeReviewer just upper-cases the text. Crucially, it never sees timestamps
// (it can't — the chunk request has none) and returns the same idx set.
type fakeReviewer struct {
	name  string
	calls atomic.Int32
}

func (f *fakeReviewer) Name() string { return f.name }

func (f *fakeReviewer) ReviewChunk(ctx context.Context, req reviewport.ChunkRequest) (reviewport.ChunkResponse, error) {
	f.calls.Add(1)
	out := make([]reviewport.ChunkSegment, len(req.Segments))
	for i, s := range req.Segments {
		out[i] = reviewport.ChunkSegment{Idx: s.Idx, Text: strings.ToUpper(s.Text)}
	}
	return reviewport.ChunkResponse{Segments: out, Models: []reviewport.ModelEntry{{Role: "single", Name: f.name, ModelID: f.name}}}, nil
}

// dropOneReviewer drops one segment to test fallback path.
type dropOneReviewer struct{}

func (dropOneReviewer) Name() string { return "drop-one" }

func (dropOneReviewer) ReviewChunk(ctx context.Context, req reviewport.ChunkRequest) (reviewport.ChunkResponse, error) {
	out := make([]reviewport.ChunkSegment, 0, len(req.Segments)-1)
	for i, s := range req.Segments {
		if i == 0 {
			continue
		}
		out = append(out, reviewport.ChunkSegment{Idx: s.Idx, Text: strings.ToUpper(s.Text)})
	}
	return reviewport.ChunkResponse{Segments: out, Models: []reviewport.ModelEntry{{Role: "single", Name: "drop-one", ModelID: "drop-one"}}}, nil
}

func setUp(t *testing.T) (UseCase, track.ID, string) {
	t.Helper()
	dir := t.TempDir()
	ctx := t.Context()
	reg, err := sqliteregistry.New(ctx, filepath.Join(dir, "index.db"), nanoid.New())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reg.Close() })

	store := fstranscript.New(dir, fsartifact.New(dir))
	id, _, err := reg.UpsertFile(ctx, track.SourceFile{Path: "/x.mp3", SHA256: "a", Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	// Synthesize raw transcript: 6 segments.
	raw := transcript.Raw{
		TrackID:  string(id),
		Language: "ru",
		Segments: []transcript.RawSegment{
			{Idx: 0, Start: 0, End: 1000, Text: "one"},
			{Idx: 1, Start: 1000, End: 2000, Text: "two"},
			{Idx: 2, Start: 2000, End: 3000, Text: "three"},
			{Idx: 3, Start: 3000, End: 4000, Text: "four"},
			{Idx: 4, Start: 4000, End: 5000, Text: "five"},
			{Idx: 5, Start: 5000, End: 6000, Text: "six"},
		},
	}
	if err := store.WriteRaw(ctx, id, "ru", raw); err != nil {
		t.Fatal(err)
	}
	return UseCase{
		Registry:    reg,
		Transcripts: store,
		ChunkSize:   3,
		Overlap:     1,
		Retries:     1,
		Clock:       systemclock.New(),
	}, id, dir
}

func TestReviewFreezesTimestamps(t *testing.T) {
	uc, id, dir := setUp(t)

	registry := reviewreg.New(0.70, 2, 0)
	registry.Register(&fakeReviewer{name: "fake"})
	uc.Reviewers = registry

	ctx := t.Context()
	res, err := uc.Run(ctx, id, "ru", Options{Models: []string{"fake"}})
	if err != nil {
		t.Fatalf("review: %v", err)
	}
	if res.Fallback != 0 {
		t.Errorf("expected no fallback, got %d (%v)", res.Fallback, res.FallbackIdx)
	}
	if res.Blocks != 6 {
		t.Errorf("blocks=%d want 6", res.Blocks)
	}

	// Read back the reviewed file and verify timestamps came verbatim from raw.
	store := fstranscript.New(dir, fsartifact.New(dir))
	raw, err := store.ReadRaw(ctx, id, "ru")
	if err != nil {
		t.Fatal(err)
	}
	reviewedPath := store.PublicTranscriptPath(id, "ru")
	bodyRaw, err := readFile(reviewedPath)
	if err != nil {
		t.Fatal(err)
	}
	var rev transcript.Reviewed
	if err := jsonUnmarshal(bodyRaw, &rev); err != nil {
		t.Fatal(err)
	}
	if len(rev.Blocks) != len(raw.Segments) {
		t.Fatalf("blocks=%d segments=%d", len(rev.Blocks), len(raw.Segments))
	}
	for i, b := range rev.Blocks {
		sb, ok := b.(transcript.SentenceBlock)
		if !ok {
			t.Fatalf("block[%d] not sentence", i)
		}
		if sb.Start != raw.Segments[i].Start || sb.End != raw.Segments[i].End {
			t.Errorf("block[%d] timestamps drifted: got [%d,%d] want [%d,%d]",
				i, sb.Start, sb.End, raw.Segments[i].Start, raw.Segments[i].End)
		}
		if sb.Text != strings.ToUpper(raw.Segments[i].Text) {
			t.Errorf("block[%d] text=%q want upper of %q", i, sb.Text, raw.Segments[i].Text)
		}
	}
}

func TestReviewFallbackOnIdxMismatch(t *testing.T) {
	uc, id, _ := setUp(t)
	registry := reviewreg.New(0.70, 2, 0)
	registry.Register(dropOneReviewer{})
	uc.Reviewers = registry

	ctx := t.Context()
	res, err := uc.Run(ctx, id, "ru", Options{Models: []string{"drop-one"}})
	if err != nil {
		t.Fatalf("review: %v", err)
	}
	if res.Fallback == 0 {
		t.Errorf("expected fallback > 0 since drop-one returns mismatched idx set")
	}
	if res.Blocks != 6 {
		t.Errorf("blocks=%d want 6", res.Blocks)
	}
}

// sentenceReviewer returns sentences groupings. The grouping policy is fixed
// per instance so we can drive deterministic merge tests across chunks.
type sentenceReviewer struct {
	name string
	// groupRule(req) -> sentences for that chunk; built per-chunk by the test.
	groupRule func(req reviewport.ChunkRequest) [][]int
}

func (s *sentenceReviewer) Name() string { return s.name }

func (s *sentenceReviewer) ReviewChunk(ctx context.Context, req reviewport.ChunkRequest) (reviewport.ChunkResponse, error) {
	out := make([]reviewport.ChunkSegment, len(req.Segments))
	for i, seg := range req.Segments {
		out[i] = reviewport.ChunkSegment{Idx: seg.Idx, Text: strings.ToUpper(seg.Text)}
	}
	return reviewport.ChunkResponse{
		Segments:  out,
		Sentences: s.groupRule(req),
		Models:    []reviewport.ModelEntry{{Role: "single", Name: s.name, ModelID: s.name}},
	}, nil
}

// Cross-chunk sentence: chunks are [0,1,2], [2,3,4], [4,5] (size=3, overlap=1).
// We want to verify:
//   - idx 2 is reported as "end of sentence" by chunk A (group [[0,1],[2]]) but
//     as "continuation" by chunk B (group [[2,3,4]]). Chunk B has more right-
//     context (distRight for idx 2 in B = 2, in A = 0), so its verdict wins:
//     2 is NOT a sentence end.
//   - Final sentences should be: [0,1] then [2,3,4] then [5].
//   - Timestamps: first sentence start=raw[0].start, end=raw[1].end; second
//     start=raw[2].start, end=raw[4].end; third start=raw[5].start, end=raw[5].end.
func TestReviewCrossChunkSentenceMerge(t *testing.T) {
	uc, id, dir := setUp(t)
	registry := reviewreg.New(0.70, 2, 0)
	rev := &sentenceReviewer{
		name: "sentencer",
		groupRule: func(req reviewport.ChunkRequest) [][]int {
			idxs := make([]int, len(req.Segments))
			for i, s := range req.Segments {
				idxs[i] = s.Idx
			}
			// Hard-code the test groupings keyed on the first idx of the chunk.
			switch idxs[0] {
			case 0: // chunk [0,1,2]
				return [][]int{{0, 1}, {2}}
			case 2: // chunk [2,3,4]
				return [][]int{{2, 3, 4}}
			case 4: // chunk [4,5]
				return [][]int{{4}, {5}}
			}
			return nil
		},
	}
	registry.Register(rev)
	uc.Reviewers = registry

	ctx := t.Context()
	res, err := uc.Run(ctx, id, "ru", Options{Models: []string{"sentencer"}})
	if err != nil {
		t.Fatalf("review: %v", err)
	}

	store := fstranscript.New(dir, fsartifact.New(dir))
	body, err := readFile(store.PublicTranscriptPath(id, "ru"))
	if err != nil {
		t.Fatal(err)
	}
	var got transcript.Reviewed
	if err := jsonUnmarshal(body, &got); err != nil {
		t.Fatal(err)
	}

	want := []transcript.SentenceBlock{
		{Start: 0, End: 2000, Text: "ONE TWO"},
		{Start: 2000, End: 5000, Text: "THREE FOUR FIVE"},
		{Start: 5000, End: 6000, Text: "SIX"},
	}
	if len(got.Blocks) != len(want) {
		t.Fatalf("blocks=%d want %d (res.Blocks=%d)", len(got.Blocks), len(want), res.Blocks)
	}
	for i, w := range want {
		sb, ok := got.Blocks[i].(transcript.SentenceBlock)
		if !ok {
			t.Fatalf("block[%d] is not sentence: %T", i, got.Blocks[i])
		}
		if sb.Start != w.Start || sb.End != w.End || sb.Text != w.Text {
			t.Errorf("block[%d] = {%d,%d,%q}; want {%d,%d,%q}",
				i, sb.Start, sb.End, sb.Text, w.Start, w.End, w.Text)
		}
	}
}

func readFile(p string) ([]byte, error) {
	return osReadFile(p)
}

// indirect to avoid dragging os import noise in tests
var osReadFile = readWholeFile
var jsonUnmarshal = jsonDecode
