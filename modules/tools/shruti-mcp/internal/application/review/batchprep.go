package review

import (
	"unicode"

	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/review/prompts"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// The helpers below build the input the model sees. The live path and the
// batch path both go through them, so the two cannot drift apart.

// chunkParams resolves the chunk size and overlap: the call's options, then
// the use case's configuration, then 50 and 4.
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
	if overlap == 0 {
		overlap = 4
	}
	if overlap < 0 {
		overlap = 0
	}
	return chunkSize, overlap
}

// filterNoise silences whisper's hallucinations on noise and silence:
// segments below the confidence threshold, and fragments with no linguistic
// content (a lone dot, an ellipsis, digit soup), which models drop from their
// reply and so break the idx-set check. Idx and timestamps stay, so chunking
// lines up; the silenced idx are returned for the audit.
func (uc UseCase) filterNoise(segs []transcript.RawSegment) (out []transcript.RawSegment, silenced []int) {
	out = make([]transcript.RawSegment, len(segs))
	copy(out, segs)
	for i := range out {
		s := &out[i]
		if uc.NoiseFilterThreshold > 0 && s.Confidence > 0 && s.Confidence < uc.NoiseFilterThreshold {
			s.Text = ""
			silenced = append(silenced, s.Idx)
			continue
		}
		if s.Text != "" && !hasMeaningfulContent(s.Text) {
			s.Text = ""
			silenced = append(silenced, s.Idx)
		}
	}
	return out, silenced
}

// hasMeaningfulContent reports whether text contains at least 2 letter
// characters (any script). Two letters keep real short words like "Я" or "и"
// out of the filter.
func hasMeaningfulContent(text string) bool {
	letters := 0
	for _, r := range text {
		if unicode.IsLetter(r) {
			letters++
			if letters >= 2 {
				return true
			}
		}
	}
	return false
}

// chunkRequest builds the request for chunk i. The previous chunk's last
// overlap segments go along as read-only context for the boundary; they are
// raw text, so chunks stay independent and can run in parallel. Glossary
// hints found in the chunk become the extra prompt, and are persisted with
// the chunk so its input is reproducible.
func (uc UseCase) chunkRequest(language string, chunks []pipelinereview.Chunk, i, overlap int) reviewport.ChunkRequest {
	req := reviewport.ChunkRequest{
		Language: language,
		Segments: reviewport.ChunkSegmentsFromRaw(chunks[i].Segs),
	}
	if i > 0 {
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
