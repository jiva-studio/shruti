package review

import (
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/review/prompts"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// The helpers below let the batch path build exactly the input the live path
// builds. Anything that diverges here changes what the model sees, so both
// paths go through the same code.

func (uc UseCase) chunkParams(opts Options) (chunkSize, overlap int) {
	chunkSize = opts.ChunkSize
	if chunkSize == 0 {
		chunkSize = uc.ChunkSize
	}
	if chunkSize == 0 {
		chunkSize = 50
	}
	overlap = opts.Overlap
	if overlap == 0 {
		overlap = uc.Overlap
	}
	if overlap < 0 {
		overlap = 0
	}
	return chunkSize, overlap
}

// filterNoise silences segments the live path also silences: below-threshold
// confidence, and fragments with no linguistic content. Idx and timestamps
// stay so the chunking lines up.
func (uc UseCase) filterNoise(segs []transcript.RawSegment) []transcript.RawSegment {
	out := make([]transcript.RawSegment, len(segs))
	copy(out, segs)
	for i := range out {
		s := &out[i]
		if uc.NoiseFilterThreshold > 0 && s.Confidence > 0 && s.Confidence < uc.NoiseFilterThreshold {
			s.Text = ""
			continue
		}
		if s.Text != "" && !hasMeaningfulContent(s.Text) {
			s.Text = ""
		}
	}
	return out
}

func (uc UseCase) chunkRequest(language string, chunks []pipelinereview.Chunk, i int,
	segs []transcript.RawSegment) reviewport.ChunkRequest {
	req := reviewport.ChunkRequest{
		Language: language,
		Segments: reviewport.ChunkSegmentsFromRaw(segs),
	}
	if i > 0 {
		_, overlap := uc.chunkParams(Options{})
		req.PrevTail = pipelinereview.LastN(reviewport.ChunkSegmentsFromRaw(chunks[i-1].Segs), overlap)
	}
	if uc.Glossary != nil {
		thr := uc.GlossaryThreshold
		if thr <= 0 {
			thr = 0.55
		}
		maxH := uc.GlossaryMaxHints
		if maxH <= 0 {
			maxH = 10
		}
		if hints := uc.Glossary.RenderHints(
			pipelinereview.JoinChunkText(req.Segments), language, thr, maxH); hints != "" {
			req.ExtraPrompt = hints
		}
	}
	return req
}

func (uc UseCase) batchUserPrompt() string { return prompts.User }
