package review

import (
	"context"
	"errors"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	reviewreg "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/review"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// failingChunkStore refuses chunk artifacts and passes everything else on.
type failingChunkStore struct {
	transcriptport.Store
	err error
}

func (s failingChunkStore) WriteReviewChunk(context.Context, track.ID, string, int, []byte) error {
	return s.err
}

// A chunk artifact is how a later run resumes and how cost is counted, so a
// run that could not write one fails rather than reporting success.
func TestRunFailsWhenAChunkArtifactCannotBeWritten(t *testing.T) {
	uc, id, _ := setUp(t)
	registry := reviewreg.New(0.70, 2, 0)
	registry.Register(&fakeReviewer{name: "fake"})
	uc.Reviewers = registry
	full := errors.New("disk full")
	uc.Transcripts = failingChunkStore{Store: uc.Transcripts, err: full}

	if _, err := uc.Run(t.Context(), id, "ru", Options{Models: []string{"fake"}}); !errors.Is(err, full) {
		t.Fatalf("Run = %v, want the artifact write error", err)
	}
}

// The batch path rebuilds requests from a job's recorded overlap; the previous
// chunk's tail must follow that overlap, not the configured one.
func TestChunkRequestTailFollowsTheGivenOverlap(t *testing.T) {
	uc := UseCase{Overlap: 1}
	var segs []transcript.RawSegment
	for i := range 8 {
		segs = append(segs, transcript.RawSegment{Idx: i, Text: "word"})
	}
	chunks := pipelinereview.BuildChunks(segs, 4, 3)
	req := uc.chunkRequest("ru", chunks, 1, 3)
	if len(req.PrevTail) != 3 {
		t.Fatalf("prev tail has %d segments, want the overlap of 3", len(req.PrevTail))
	}
}

func TestFilterNoiseSilencesWithoutDroppingSegments(t *testing.T) {
	uc := UseCase{NoiseFilterThreshold: 0.2}
	in := []transcript.RawSegment{
		{Idx: 0, Text: "слово", Confidence: 0.9},
		{Idx: 1, Text: "12", Confidence: 0.1},
		{Idx: 2, Text: "...", Confidence: 0.4},
		{Idx: 3, Text: "и я", Confidence: 0.4},
	}
	out, silenced := uc.filterNoise(in)
	if len(out) != len(in) || out[1].Text != "" || out[2].Text != "" || out[3].Text != "и я" {
		t.Fatalf("filtered %+v", out)
	}
	if len(silenced) != 2 || silenced[0] != 1 || silenced[1] != 2 {
		t.Fatalf("silenced %v", silenced)
	}
	if in[1].Text != "12" {
		t.Fatal("the input segments were modified")
	}
}
