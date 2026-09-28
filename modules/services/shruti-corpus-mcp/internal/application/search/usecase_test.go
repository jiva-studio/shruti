package search

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/domain/corpus"
)

type fakeEmbed struct{ err error }

func (f fakeEmbed) Query(context.Context, string) ([]float32, error) { return []float32{1}, f.err }

type hybridCall struct {
	kinds    []string
	limit    int
	trackIDs []string
}

type fakeRetriever struct {
	chunks []corpus.Chunk
	err    error
	calls  []hybridCall
}

func (f *fakeRetriever) Hybrid(_ context.Context, _ string, _ []float32, kinds []string, _ string,
	limit int, _ float64, trackIDs []string) ([]corpus.Chunk, corpus.LaneTimings, error) {
	f.calls = append(f.calls, hybridCall{kinds: kinds, limit: limit, trackIDs: trackIDs})
	return f.chunks, corpus.LaneTimings{VectorMs: 1, LexicalMs: 2}, f.err
}

type fakeTracks struct {
	citing    []string
	tracks    map[string]*corpus.Track
	getCalls  [][]string
	citeCalls int
}

func (f *fakeTracks) TrackIDsByRef(context.Context, string, string) ([]string, error) {
	f.citeCalls++
	return f.citing, nil
}

func (f *fakeTracks) GetTracks(_ context.Context, ids []string) (map[string]*corpus.Track, error) {
	f.getCalls = append(f.getCalls, ids)
	out := map[string]*corpus.Track{}
	for _, id := range ids {
		if t, ok := f.tracks[id]; ok {
			out[id] = t
		}
	}
	return out, nil
}

func str(s string) *string { return &s }

func trackChunk(id string, score float64) corpus.Chunk {
	return corpus.Chunk{Kind: "track_transcript", TrackID: str(id), Score: score}
}

func track(id, author, date string, refs ...corpus.Reference) *corpus.Track {
	t := corpus.NewTrack(id, author, "", date)
	t.Refs = refs
	return t
}

func TestChunkKindsForTypes(t *testing.T) {
	got, err := ChunkKindsForTypes([]string{"document", " Track ", "document", ""})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"commentary", "prose_chapter", "letter", "track_transcript"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("kinds = %v, want %v", got, want)
	}
	if _, err := ChunkKindsForTypes([]string{"podcast"}); !errors.Is(err, ErrInvalidArgument) || err.Error() != "invalid type: podcast" {
		t.Fatalf("unknown type: %v", err)
	}
}

func TestTrackSearchUnderAReferencePrefiltersRecall(t *testing.T) {
	ret := &fakeRetriever{chunks: []corpus.Chunk{trackChunk("t1", 0.9)}}
	tracks := &fakeTracks{
		citing: []string{"t1", "t2"},
		// t1 cites 2.13 while the request asks for chapter 2: the prefix
		// match already happened in TrackIDsByRef, so the hit stays.
		tracks: map[string]*corpus.Track{"t1": track("t1", "", "", corpus.Reference{SourceID: "bg", Tokens: "2.13"})},
	}
	uc := UseCase{Embed: fakeEmbed{}, Retrieve: ret, Tracks: tracks}
	res, err := uc.Run(t.Context(), Request{Query: "q", Types: []string{"track"}, SourceID: "bg", Tokens: "2", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(ret.calls) != 1 || !reflect.DeepEqual(ret.calls[0].trackIDs, []string{"t1", "t2"}) || ret.calls[0].limit != 10 {
		t.Fatalf("lanes called with %+v, want the citing tracks and no over-fetch", ret.calls)
	}
	if len(res.Hits) != 1 || res.Hits[0].Track.ID != "t1" || !res.Retrieved {
		t.Fatalf("hits = %+v", res)
	}
}

func TestNothingCitingTheReferenceSkipsRetrieval(t *testing.T) {
	ret := &fakeRetriever{}
	uc := UseCase{Embed: fakeEmbed{err: errors.New("must not embed")}, Retrieve: ret, Tracks: &fakeTracks{}}
	res, err := uc.Run(t.Context(), Request{Query: "q", Types: []string{"track"}, SourceID: "bg", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.Retrieved || len(res.Hits) != 0 || len(ret.calls) != 0 {
		t.Fatalf("result %+v after %d lane calls", res, len(ret.calls))
	}
}

func TestPostFiltersReadEveryHitTrackInOneBatch(t *testing.T) {
	ret := &fakeRetriever{chunks: []corpus.Chunk{
		trackChunk("t1", 0.9),
		trackChunk("t2", 0.8),
		trackChunk("t1", 0.7),
		trackChunk("hidden", 0.6),
		{Kind: "verse", SourceID: str("bg"), Tokens: str("2.13"), Score: 0.5},
		trackChunk("t3", 0.4),
	}}
	tracks := &fakeTracks{tracks: map[string]*corpus.Track{
		"t1": track("t1", "a1", "1974-01-01", corpus.Reference{SourceID: "bg", Tokens: "2.13"}),
		"t2": track("t2", "a2", "1974-01-01", corpus.Reference{SourceID: "bg", Tokens: "2.13"}),
		"t3": track("t3", "a1", "1974-01-01", corpus.Reference{SourceID: "sb", Tokens: "1.1"}),
	}}
	uc := UseCase{Embed: fakeEmbed{}, Retrieve: ret, Tracks: tracks}
	res, err := uc.Run(t.Context(), Request{Query: "q", SourceID: "bg", Tokens: "2.13", AuthorID: "a1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks.getCalls) != 1 || !reflect.DeepEqual(tracks.getCalls[0], []string{"t1", "t2", "hidden", "t3"}) {
		t.Fatalf("track reads: %v, want one batch of distinct ids", tracks.getCalls)
	}
	if ret.calls[0].limit != 80 || ret.calls[0].trackIDs != nil {
		t.Fatalf("over-fetch: %+v", ret.calls[0])
	}
	// t1 twice (author a1, cites bg 2.13); t2 has another author, t3 cites
	// another book, the verse is excluded by the author filter.
	var got []string
	for _, h := range res.Hits {
		got = append(got, corpus.Deref(h.Chunk.TrackID))
	}
	if !reflect.DeepEqual(got, []string{"t1", "t1"}) {
		t.Fatalf("kept %v", got)
	}
}

func TestLimitMinScoreAndMediaFilters(t *testing.T) {
	ret := &fakeRetriever{chunks: []corpus.Chunk{
		{Kind: "media", ItemID: str("m1"), Score: 0.9},
		{Kind: "media", Score: 0.85},
		{Kind: "commentary", Score: 0.8, ItemID: str("d1")},
		{Kind: "letter", Score: 0.1, ItemID: str("d2")},
	}}
	uc := UseCase{Embed: fakeEmbed{}, Retrieve: ret, Tracks: &fakeTracks{}}
	res, err := uc.Run(t.Context(), Request{Query: "q", Limit: 2, MinScore: 0.5})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || res.Hits[0].Chunk.Kind != "media" || res.Hits[1].Chunk.Kind != "commentary" {
		t.Fatalf("hits = %+v", res.Hits)
	}

	res, err = uc.Run(t.Context(), Request{Query: "q", Kind: "letter", Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"verse", "letter", "track_transcript", "title", "media"}; !reflect.DeepEqual(ret.calls[1].kinds, want) {
		t.Fatalf("a document kind filter kept kinds %v", ret.calls[1].kinds)
	}
	for _, h := range res.Hits {
		if h.Chunk.Kind != "letter" {
			t.Fatalf("kind=letter kept a %s hit", h.Chunk.Kind)
		}
	}
}

func TestBackendFailuresAreDependencyErrors(t *testing.T) {
	boom := errors.New("boom")
	uc := UseCase{Embed: fakeEmbed{err: boom}, Retrieve: &fakeRetriever{}, Tracks: &fakeTracks{}}
	var dep *DependencyError
	if _, err := uc.Run(t.Context(), Request{Query: "q", Limit: 1}); !errors.As(err, &dep) || dep.Error() != "embed query: boom" {
		t.Fatalf("embed failure: %v", err)
	}
	uc = UseCase{Embed: fakeEmbed{}, Retrieve: &fakeRetriever{err: boom}, Tracks: &fakeTracks{}}
	if _, err := uc.Run(t.Context(), Request{Query: "q", Limit: 1}); !errors.As(err, &dep) || dep.Error() != "boom" {
		t.Fatalf("retrieval failure: %v", err)
	}
}
