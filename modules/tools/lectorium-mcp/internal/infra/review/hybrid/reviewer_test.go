package hybridreview

import (
	"context"
	"testing"

	"github.com/jiva-studio/lectorium/pipeline/ports/review"
)

// fakeReviewer is a programmable inner reviewer for hybrid tests. It
// records every ReviewChunk call (the request) and returns a canned
// response (or error if Err != nil). When RespondText is set, every
// returned segment text is rewritten to RespondText + idx.
type fakeReviewer struct {
	name        string
	calls       []review.ChunkRequest
	respondText string
	respondSent func(req review.ChunkRequest) [][]int
	err         error
}

func (f *fakeReviewer) Name() string { return f.name }
func (f *fakeReviewer) ReviewChunk(_ context.Context, req review.ChunkRequest) (review.ChunkResponse, error) {
	f.calls = append(f.calls, req)
	if f.err != nil {
		return review.ChunkResponse{}, f.err
	}
	segs := make([]review.ChunkSegment, len(req.Segments))
	for i, s := range req.Segments {
		t := s.Text
		if f.respondText != "" {
			t = f.respondText + ":" + s.Text
		}
		segs[i] = review.ChunkSegment{Idx: s.Idx, Text: t}
	}
	var sents [][]int
	if f.respondSent != nil {
		sents = f.respondSent(req)
	} else {
		// default: one sentence per segment
		sents = make([][]int, len(req.Segments))
		for i, s := range req.Segments {
			sents[i] = []int{s.Idx}
		}
	}
	return review.ChunkResponse{
		Segments:  segs,
		Sentences: sents,
		Models: []review.ModelEntry{{
			Role:      "single",
			Name:      f.name,
			ModelID:   f.name,
			TokensIn:  100,
			TokensOut: 100,
		}},
	}, nil
}

func makeChunk(n int, lowAt map[int]bool) review.ChunkRequest {
	segs := make([]review.ChunkSegment, n)
	for i := 0; i < n; i++ {
		conf := 0.95
		if lowAt[i] {
			conf = 0.30
		}
		segs[i] = review.ChunkSegment{Idx: 100 + i, Text: "raw" + itoa(i), Confidence: conf}
	}
	return review.ChunkRequest{Language: "en", Segments: segs}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	out := []byte{}
	for i > 0 {
		out = append([]byte{byte('0' + i%10)}, out...)
		i /= 10
	}
	return string(out)
}

func TestHybrid_AllHighConf(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	req := makeChunk(50, nil)
	resp, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(cheap.calls) != 1 {
		t.Errorf("cheap should be called once, got %d", len(cheap.calls))
	}
	if len(premium.calls) != 0 {
		t.Errorf("premium should NOT be called, got %d", len(premium.calls))
	}
	if len(resp.Models) != 1 {
		t.Fatalf("models = %d entries, want 1 (baseline only)", len(resp.Models))
	}
	if resp.Models[0].Role != "baseline" {
		t.Errorf("role = %q, want baseline", resp.Models[0].Role)
	}
	if resp.Models[0].Name != "cheap" {
		t.Errorf("name = %q, want cheap", resp.Models[0].Name)
	}
}

func TestHybrid_SingleLowSegment_ExpandsToWindow(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium", respondText: "P"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	req := makeChunk(50, map[int]bool{20: true})
	_, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(premium.calls) != 1 {
		t.Fatalf("premium should be called once, got %d", len(premium.calls))
	}
	got := premium.calls[0].Segments
	if len(got) != 5 {
		t.Errorf("expanded island should be 5 segs (18..22), got %d", len(got))
	}
	if got[0].Idx != 118 || got[len(got)-1].Idx != 122 {
		t.Errorf("expanded island idx range = [%d..%d], want [118..122]", got[0].Idx, got[len(got)-1].Idx)
	}
}

func TestHybrid_AdjacentIslandsMerge(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium", respondText: "P"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	low := map[int]bool{10: true, 11: true, 12: true, 14: true, 15: true, 16: true}
	req := makeChunk(50, low)
	_, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(premium.calls) != 1 {
		t.Fatalf("two adjacent islands should merge into 1 premium call, got %d", len(premium.calls))
	}
	got := premium.calls[0].Segments
	if got[0].Idx != 108 || got[len(got)-1].Idx != 118 {
		t.Errorf("merged island idx range = [%d..%d], want [108..118]", got[0].Idx, got[len(got)-1].Idx)
	}
}

func TestHybrid_IslandAtChunkStart_ClampsLeft(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium", respondText: "P"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	req := makeChunk(50, map[int]bool{0: true, 1: true, 2: true})
	_, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	got := premium.calls[0].Segments
	if got[0].Idx != 100 {
		t.Errorf("expansion at start should clamp at idx 100, got %d", got[0].Idx)
	}
	if got[len(got)-1].Idx != 104 {
		t.Errorf("expansion right edge should be 104 (2..4), got %d", got[len(got)-1].Idx)
	}
}

func TestHybrid_TextOverrideOnlyInsideOriginalIsland(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium", respondText: "P"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	// Original island = [10..12]. After expand=2, premium sees [8..14].
	req := makeChunk(50, map[int]bool{10: true, 11: true, 12: true})
	resp, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	// Build idx → text map for assertions.
	got := map[int]string{}
	for _, s := range resp.Segments {
		got[s.Idx] = s.Text
	}
	// Expansion zone idx 108, 109, 113, 114 → cheap text (no "P:" prefix).
	for _, idx := range []int{108, 109, 113, 114} {
		if got[idx] != "raw"+itoa(idx-100) {
			t.Errorf("expansion-zone idx %d should keep cheap text %q, got %q",
				idx, "raw"+itoa(idx-100), got[idx])
		}
	}
	// Original island idx 110, 111, 112 → premium text ("P:rawN").
	for _, idx := range []int{110, 111, 112} {
		want := "P:raw" + itoa(idx-100)
		if got[idx] != want {
			t.Errorf("original-island idx %d should use premium text %q, got %q", idx, want, got[idx])
		}
	}
}

func TestHybrid_PremiumSentenceBoundariesOverrideForIsland(t *testing.T) {
	cheap := &fakeReviewer{
		name: "cheap",
		// cheap groups everything as 1 segment per sentence (default).
	}
	premium := &fakeReviewer{
		name:        "premium",
		respondText: "P",
		respondSent: func(req review.ChunkRequest) [][]int {
			// Group [0..1] then [2] then individuals — premium sees idx
			// list e.g. [108,109,110,111,112,113,114] when island [10..12]
			// is expanded ±2. We group the original island half-and-half
			// to verify boundary override.
			if len(req.Segments) == 0 {
				return nil
			}
			ids := make([]int, len(req.Segments))
			for i, s := range req.Segments {
				ids[i] = s.Idx
			}
			// First two together, the rest singletons.
			out := [][]int{{ids[0], ids[1]}}
			for _, id := range ids[2:] {
				out = append(out, []int{id})
			}
			return out
		},
	}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	req := makeChunk(50, map[int]bool{10: true, 11: true, 12: true})
	resp, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	// Premium sentences: [[108,109],[110],[111],[112],[113],[114]].
	// Island idxs (orig+expansion): {108..114}. So closes should be set
	// on 109,110,111,112,113,114 (the last of each premium sentence
	// inside island_full_idx_set).
	// All segs outside [108..114] use cheap which closes every singleton.
	wantCloses := map[int]bool{}
	for i := 0; i < 50; i++ {
		idx := 100 + i
		if idx >= 108 && idx <= 114 {
			// premium boundaries: 109 (end of [108,109]), 110, 111, 112,
			// 113, 114 close. 108 does NOT close (it's first in [108,109]).
			wantCloses[idx] = idx != 108
		} else {
			// cheap default: every segment closes
			wantCloses[idx] = true
		}
	}

	gotCloses := map[int]bool{}
	for _, group := range resp.Sentences {
		if len(group) == 0 {
			continue
		}
		gotCloses[group[len(group)-1]] = true
	}

	for idx, want := range wantCloses {
		if want && !gotCloses[idx] {
			t.Errorf("idx %d should close a sentence", idx)
		}
	}
	// Sanity: 108 should NOT be the last in any sentence.
	if gotCloses[108] {
		t.Error("idx 108 should NOT close a sentence (premium grouped with 109)")
	}
}

func TestHybrid_NoLowConf_NoPremium(t *testing.T) {
	cheap := &fakeReviewer{name: "cheap"}
	premium := &fakeReviewer{name: "premium"}
	r := New([]review.Reviewer{cheap, premium}, 0.70, 2, 0)

	req := makeChunk(20, nil) // all conf=0.95
	resp, err := r.ReviewChunk(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(premium.calls) != 0 {
		t.Errorf("premium should not be called, got %d calls", len(premium.calls))
	}
	premiumCount := 0
	for _, m := range resp.Models {
		if m.Role == "premium" {
			premiumCount++
		}
	}
	if premiumCount != 0 {
		t.Errorf("premium entries = %d, want 0", premiumCount)
	}
}

func TestHybrid_GroupRuns(t *testing.T) {
	cases := []struct {
		in  []int
		out []interval
	}{
		{nil, nil},
		{[]int{}, nil},
		{[]int{5}, []interval{{5, 5}}},
		{[]int{3, 4, 5, 7, 9, 10}, []interval{{3, 5}, {7, 7}, {9, 10}}},
	}
	for _, c := range cases {
		got := groupRuns(append([]int{}, c.in...))
		if !equalIntervals(got, c.out) {
			t.Errorf("groupRuns(%v) = %v, want %v", c.in, got, c.out)
		}
	}
}

func TestHybrid_ExpandAndMerge(t *testing.T) {
	in := []interval{{10, 12}, {14, 16}}
	got := expandAndMerge(in, 2, 50)
	want := []interval{{8, 18}}
	if !equalIntervals(got, want) {
		t.Errorf("expandAndMerge = %v, want %v (overlap should merge)", got, want)
	}
	// Independent islands, far apart
	in2 := []interval{{5, 5}, {30, 30}}
	got2 := expandAndMerge(in2, 2, 50)
	want2 := []interval{{3, 7}, {28, 32}}
	if !equalIntervals(got2, want2) {
		t.Errorf("expandAndMerge non-overlapping = %v, want %v", got2, want2)
	}
}

func equalIntervals(a, b []interval) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
