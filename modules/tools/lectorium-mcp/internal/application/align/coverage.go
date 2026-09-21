package align

import (
	"context"
	"fmt"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// MinTextShare is the share of the ASR text an alignment must carry. Set far
// below a healthy result: edited prose legitimately drops questions from the
// floor and closing kirtan. Near zero means the aligner matched nothing.
const MinTextShare = 0.05

// checkCoverage rejects an alignment that produced essentially no text.
func (uc UseCase) checkCoverage(ctx context.Context, id track.ID, language string,
	rev transcript.Reviewed) error {
	if len(rev.Blocks) == 0 {
		return fmt.Errorf("align: alignment produced no blocks for %s/%s — the canonical transcript is empty or unreadable",
			id, language)
	}
	raw, ok := uc.readRawForCompare(ctx, id, language)
	if !ok {
		return nil
	}
	var rawChars int
	for _, s := range raw.Segments {
		rawChars += len([]rune(s.Text))
	}
	if rawChars == 0 {
		return nil
	}
	var gotChars int
	for _, b := range rev.Blocks {
		if s, ok := b.(transcript.SentenceBlock); ok {
			gotChars += len([]rune(s.Text))
		}
	}
	if float64(gotChars) < float64(rawChars)*MinTextShare {
		return fmt.Errorf("align: alignment kept %d of %d ASR characters (%.2f%%) for %s/%s — the canonical transcript is empty or belongs to another recording",
			gotChars, rawChars, float64(gotChars)/float64(rawChars)*100, id, language)
	}
	return nil
}

// A read that fails is not a verdict: with nothing to measure against, the
// guard stands down rather than reject what it cannot judge.
func (uc UseCase) readRawForCompare(
	ctx context.Context, id track.ID, language string,
) (transcript.Raw, bool) {
	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err != nil {
		return transcript.Raw{}, false
	}
	return raw, len(raw.Segments) > 0
}
