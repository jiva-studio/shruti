// Package translate holds source-agnostic helpers that turn a reviewed
// transcript into a translated one via the translate.Translator port. It is the
// shared step both ingest paths speak (the corpus pipeline and the
// personal-library worker); it does not persist anything.
package translate

import (
	"context"

	translateport "github.com/jiva-studio/shruti/pipeline/ports/translate"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// Reviewed returns a copy of rev with every sentence block's text translated
// into toLang and the artifact's Language set to toLang. Timings, speaker
// labels, and non-sentence blocks are preserved. Best-effort per line via the
// batch primitive: a line that fails to translate keeps its source text, so the
// block list always stays 1:1 with the source.
func Reviewed(
	ctx context.Context, tr translateport.Translator, rev transcript.Reviewed, fromLang, toLang string,
) (transcript.Reviewed, error) {
	idx := make([]int, 0, len(rev.Blocks))
	texts := make([]string, 0, len(rev.Blocks))
	for i, b := range rev.Blocks {
		if sb, ok := b.(transcript.SentenceBlock); ok {
			idx = append(idx, i)
			texts = append(texts, sb.Text)
		}
	}
	translated, err := tr.TranslateBatch(ctx, texts, fromLang, toLang)
	if err != nil {
		return transcript.Reviewed{}, err
	}

	blocks := make([]transcript.Block, len(rev.Blocks))
	copy(blocks, rev.Blocks)
	for k, i := range idx {
		sb := blocks[i].(transcript.SentenceBlock)
		sb.Text = translated[k]
		blocks[i] = sb
	}

	out := rev
	out.Language = toLang
	out.Blocks = blocks
	return out, nil
}
