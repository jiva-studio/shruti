package review

import (
	"context"
	"testing"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

func TestReview_NormalizesMetadata(t *testing.T) {
	got, err := New().Review(context.Background(), ingest.TrackDraft{
		TitleRaw: "  A Talk  ", LangHint: "en", DateRaw: " 1972 ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Lang != "en" {
		t.Fatalf("lang = %q, want en", got.Lang)
	}
	if got.Date != "1972" {
		t.Fatalf("date = %q, want 1972", got.Date)
	}
	if got.TitleRaw != "A Talk" {
		t.Fatalf("title = %q, want trimmed", got.TitleRaw)
	}
}

func TestNormalizeTranscript_FallbackBlocks(t *testing.T) {
	raw := transcript.Raw{
		TrackId:  "t1",
		Language: "en",
		Segments: []transcript.RawSegment{
			{Idx: 0, Start: 0, End: 1000, Text: "Hello"},
			{Idx: 1, Start: 1000, End: 2000, Text: "  "}, // blank → dropped
			{Idx: 2, Start: 2000, End: 3000, Text: "world"},
		},
	}
	rev := NormalizeTranscript(raw)
	if rev.TrackId != "t1" || rev.Language != "en" || rev.Version != 1 {
		t.Fatalf("header wrong: %+v", rev)
	}
	if len(rev.Blocks) != 2 {
		t.Fatalf("blocks = %d, want 2 (blank dropped)", len(rev.Blocks))
	}
	sb, ok := rev.Blocks[0].(transcript.SentenceBlock)
	if !ok || sb.Text != "Hello" || sb.Start != 0 || sb.End != 1000 {
		t.Fatalf("first block wrong: %+v", rev.Blocks[0])
	}
}
