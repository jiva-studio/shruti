package review

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

type fakeBatcher struct {
	submitted []BatchRequest
	name      string
	job       BatchJob
	results   []BatchResult
	submitErr error
}

func (f *fakeBatcher) Submit(_ context.Context, _ string, reqs []BatchRequest) (string, error) {
	if f.submitErr != nil {
		return "", f.submitErr
	}
	f.submitted = append(f.submitted, reqs...)
	return f.name, nil
}

func (f *fakeBatcher) Fetch(_ context.Context, _ string) (BatchJob, []BatchResult, error) {
	return f.job, f.results, nil
}

type fakeJobs struct {
	saved map[string]BatchRecord
}

func newFakeJobs() *fakeJobs { return &fakeJobs{saved: map[string]BatchRecord{}} }

func (f *fakeJobs) Save(_ context.Context, rec BatchRecord) error {
	f.saved[rec.Name] = rec
	return nil
}

func (f *fakeJobs) Load(_ context.Context, name string) (BatchRecord, error) {
	rec, ok := f.saved[name]
	if !ok {
		return BatchRecord{}, fmt.Errorf("no record for %q", name)
	}
	return rec, nil
}

func (f *fakeJobs) List(context.Context) ([]BatchRecord, error) {
	out := make([]BatchRecord, 0, len(f.saved))
	for _, r := range f.saved {
		out = append(out, r)
	}
	return out, nil
}

// memStore is the slice of transcriptport.Store the batch path touches.
type memStore struct {
	raw    transcript.Raw
	chunks map[int][]byte
}

func newMemStore(n int) *memStore {
	segs := make([]transcript.RawSegment, n)
	for i := range segs {
		segs[i] = transcript.RawSegment{
			Idx: i, Start: int64(i * 1000), End: int64((i + 1) * 1000),
			Text: fmt.Sprintf("сегмент %d", i), Confidence: 0.9,
		}
	}
	return &memStore{raw: transcript.Raw{Segments: segs}, chunks: map[int][]byte{}}
}

func (m *memStore) ReadRaw(context.Context, track.Id, string) (transcript.Raw, error) {
	return m.raw, nil
}

func (m *memStore) WriteReviewChunk(_ context.Context, _ track.Id, _ string, idx int, body []byte) error {
	m.chunks[idx] = body
	return nil
}

func (m *memStore) ReadReviewChunk(_ context.Context, _ track.Id, _ string, idx int) ([]byte, error) {
	body, ok := m.chunks[idx]
	if !ok {
		return nil, fmt.Errorf("absent")
	}
	return body, nil
}

func (m *memStore) WriteRaw(context.Context, track.Id, string, transcript.Raw) error { return nil }
func (m *memStore) WriteReviewed(context.Context, transcript.Reviewed) error         { return nil }
func (m *memStore) ReadReviewed(context.Context, track.Id, string) (transcript.Reviewed, error) {
	return transcript.Reviewed{}, fmt.Errorf("absent")
}
func (m *memStore) WriteReviewSession(context.Context, track.Id, string, []byte) error { return nil }
func (m *memStore) ReadReviewSession(context.Context, track.Id, string) ([]byte, error) {
	return nil, fmt.Errorf("absent")
}

func (m *memStore) PublicTranscriptKey(id track.Id, language string) string {
	return "public/tracks/" + string(id) + "/transcripts/" + language + ".json"
}

func batchUC(store *memStore, b Batcher, jobs BatchStore) UseCase {
	return UseCase{
		Transcripts:    store,
		Batch:          b,
		BatchJobs:      jobs,
		ChunkSize:      10,
		Overlap:        2,
		BatchModel:     "gemini-flash-lite-latest",
		BatchMaxTokens: 8192,
		BatchPriceIn:   0.125,
		BatchPriceOut:  0.75,
	}
}

func TestSubmitBatchKeysEveryChunk(t *testing.T) {
	store := newMemStore(25) // 10 per chunk, overlap 2 -> 3 chunks
	fb := &fakeBatcher{name: "batches/x"}
	jobs := newFakeJobs()
	uc := batchUC(store, fb, jobs)

	res, err := uc.SubmitBatch(context.Background(), []track.Id{"track_a"}, "ru", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Name != "batches/x" || res.Chunks != len(fb.submitted) {
		t.Fatalf("res = %+v, submitted %d", res, len(fb.submitted))
	}
	if res.Tracks["track_a"] != res.Chunks {
		t.Errorf("track chunk count %d != %d", res.Tracks["track_a"], res.Chunks)
	}
	for i, r := range fb.submitted {
		want := fmt.Sprintf("track_a:%d", i)
		if r.Key != want {
			t.Errorf("key %d = %q, want %q", i, r.Key, want)
		}
		if r.System == "" || !strings.Contains(r.System, "ENDS") {
			t.Errorf("request %d carries no line-format system prompt", i)
		}
		if !strings.Contains(r.User, "CHUNK:") {
			t.Errorf("request %d carries no chunk", i)
		}
	}
	// The record has to survive for collect, which may run after a restart.
	rec, err := jobs.Load(context.Background(), "batches/x")
	if err != nil {
		t.Fatal(err)
	}
	if rec.ChunkSize != 10 || rec.Overlap != 2 || rec.Tracks["track_a"] != res.Chunks {
		t.Errorf("record = %+v", rec)
	}
}

func TestSubmitBatchRefusesWithoutConfig(t *testing.T) {
	uc := UseCase{Transcripts: newMemStore(5)}
	if _, err := uc.SubmitBatch(context.Background(), []track.Id{"a"}, "ru", Options{}); err == nil ||
		!strings.Contains(err.Error(), "not configured") {
		t.Fatalf("err = %v", err)
	}
}

func TestSubmitBatchRefusesEmptySelection(t *testing.T) {
	uc := batchUC(newMemStore(5), &fakeBatcher{name: "b"}, newFakeJobs())
	if _, err := uc.SubmitBatch(context.Background(), nil, "ru", Options{}); err == nil ||
		!strings.Contains(err.Error(), "no tracks") {
		t.Fatalf("err = %v", err)
	}
}

// A reply becomes an ordinary chunk artifact, which is what lets the live
// review reuse it and pay only for what the job did not deliver.
func TestCollectBatchWritesChunkArtifacts(t *testing.T) {
	store := newMemStore(25)
	fb := &fakeBatcher{name: "batches/x"}
	jobs := newFakeJobs()
	uc := batchUC(store, fb, jobs)
	if _, err := uc.SubmitBatch(context.Background(), []track.Id{"track_a"}, "ru", Options{}); err != nil {
		t.Fatal(err)
	}

	chunks := len(fb.submitted)
	fb.job = BatchJob{Name: "batches/x", State: "BATCH_STATE_SUCCEEDED",
		Total: chunks, Successful: chunks}
	for i := range fb.submitted {
		fb.results = append(fb.results, BatchResult{
			Key:      fmt.Sprintf("track_a:%d", i),
			Text:     replyFor(store, i, 10, 2),
			TokensIn: 1000, TokensOut: 200,
		})
	}
	// Run() needs a registry; this test checks the artifacts directly instead.
	rec, _ := jobs.Load(context.Background(), "batches/x")
	prepared, err := uc.prepareChunks(context.Background(), "track_a", rec)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range fb.results {
		if err := uc.persistBatchChunk(context.Background(), "track_a", rec, prepared, i, r); err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
	}
	if len(store.chunks) != chunks {
		t.Fatalf("wrote %d artifacts, want %d", len(store.chunks), chunks)
	}
	var art struct {
		OK     bool `json:"ok"`
		Models []struct {
			Role      string  `json:"role"`
			TokensIn  int64   `json:"tokens_in"`
			TokensOut int64   `json:"tokens_out"`
			CostUSD   float64 `json:"cost_usd"`
		} `json:"models"`
		Response struct {
			Segments []struct {
				Idx  int    `json:"idx"`
				Text string `json:"text"`
			} `json:"segments"`
		} `json:"response"`
	}
	if err := json.Unmarshal(store.chunks[0], &art); err != nil {
		t.Fatal(err)
	}
	if !art.OK {
		t.Error("artifact must be ok so the live review reuses it")
	}
	if len(art.Models) != 1 || art.Models[0].Role != "batch" {
		t.Fatalf("models = %+v", art.Models)
	}
	// 1000 in at 0.125/M plus 200 out at 0.75/M.
	if want := 1000.0/1e6*0.125 + 200.0/1e6*0.75; art.Models[0].CostUSD != want {
		t.Errorf("cost = %v, want %v", art.Models[0].CostUSD, want)
	}
	if len(art.Response.Segments) == 0 {
		t.Error("artifact carries no corrected segments")
	}
}

func TestBatchCostIsZeroWithoutRates(t *testing.T) {
	uc := UseCase{}
	if got := uc.batchCost(1_000_000, 1_000_000); got != 0 {
		t.Errorf("cost = %v, want 0 when no rates are configured", got)
	}
}

func TestParseBatchKey(t *testing.T) {
	for _, tc := range []struct {
		in  string
		id  string
		idx int
		ok  bool
	}{
		{"track_a:0", "track_a", 0, true},
		{"track_a:12", "track_a", 12, true},
		{"track:with:colons:3", "track:with:colons", 3, true},
		{"track_a", "", 0, false},
		{":3", "", 0, false},
		{"track_a:x", "", 0, false},
	} {
		id, idx, ok := parseBatchKey(tc.in)
		if ok != tc.ok || (ok && (id != tc.id || idx != tc.idx)) {
			t.Errorf("parseBatchKey(%q) = %q,%d,%v", tc.in, id, idx, ok)
		}
	}
}

// replyFor builds a line-format reply that corrects the first segment of a
// chunk and closes the chunk with a boundary.
func replyFor(store *memStore, chunkIdx, size, overlap int) string {
	step := size - overlap
	start := chunkIdx * step
	end := start + size
	if end > len(store.raw.Segments) {
		end = len(store.raw.Segments)
	}
	first := store.raw.Segments[start].Idx
	last := store.raw.Segments[end-1].Idx
	return fmt.Sprintf("%d|Исправленный сегмент.\nENDS\n%d,%d", first, first, last)
}
