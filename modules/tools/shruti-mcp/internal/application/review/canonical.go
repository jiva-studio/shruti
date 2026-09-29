package review

import (
	"context"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/align"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

// runCanonical is the early branch for a track that ships an authoritative
// transcript (transcript.pdf, or the transcript.html an importer saved): the
// text is already correct, so the LLM is skipped and the ASR timings are
// projected onto it. handled is false when the LLM path should run instead.
//
// method "auto" (or empty) takes the branch when a canonical text exists,
// "pdf" requires one, "llm" never takes it.
func (uc UseCase) runCanonical(ctx context.Context, id track.ID, language, method string) (res Result, handled bool, err error) {
	if uc.Align == nil {
		return Result{}, false, nil
	}
	method = strings.ToLower(strings.TrimSpace(method))
	if method == "" {
		method = "auto"
	}
	haveCanonical := align.PDFExists(uc.OutDir, id) || align.TextExists(uc.OutDir, id)
	switch method {
	case "pdf":
		if !haveCanonical {
			return Result{}, false, fmt.Errorf("review: method=pdf requested but no canonical transcript for %s", id)
		}
	case "auto":
		if !haveCanonical {
			return Result{}, false, nil
		}
	case "llm":
		return Result{}, false, nil
	default:
		return Result{}, false, fmt.Errorf("review: unknown method %q (want auto|pdf|llm)", method)
	}
	ar, err := uc.Align.RunInternal(ctx, id, language)
	if err != nil {
		return Result{}, false, err
	}
	return Result{TrackID: id, Language: language, Blocks: ar.Blocks}, true, nil
}
