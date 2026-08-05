package align

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// MinTextShare is the share of the ASR text an alignment has to carry before
// we believe it happened at all.
//
// It is deliberately far below what a healthy alignment produces. A canonical
// transcript is edited prose and covers only what the editor chose to write
// down — often just the teacher's talk, leaving questions from the floor and
// closing kirtan untranscribed — so a legitimate result can sit at a fifth of
// the ASR length. Anything near zero is a different thing: an empty or
// unparseable canonical file, where the aligner matched nothing and still
// returned a well-formed transcript.
const MinTextShare = 0.05

// checkCoverage rejects an alignment that produced essentially no text.
func (uc UseCase) checkCoverage(ctx context.Context, id track.Id, language string,
	rev transcript.Reviewed) error {
	if len(rev.Blocks) == 0 {
		return fmt.Errorf("align: alignment produced no blocks for %s/%s — the canonical transcript is empty or unreadable",
			id, language)
	}
	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err != nil || len(raw.Segments) == 0 {
		return nil // nothing to compare against; leave the result alone
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
