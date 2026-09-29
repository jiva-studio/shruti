// Package stagefail provides one tiny helper used by every per-stage Run
// method to make the lake-registry stage row Failed when the function
// leaves without writing StatusDone — context cancellation, panics that
// recover up the stack, or any returned error.
//
// Usage at the top of a Run, immediately after a successful TryClaimStage:
//
//	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)
//
// Where Run uses named returns: `func (...) (res ResType, rerr error)`.
//
// On a clean Done path the helper is a no-op (rerr==nil && ctx.Err()==nil).
package stagefail

import (
	"context"
	"errors"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
)

// MarkOnExit writes StatusFailed when rerr is non-nil OR ctx has been
// cancelled, recording it on a context detached from ctx so the failure is
// written even when ctx is done. A failed write is joined into *rerr.
func MarkOnExit(reg lakeport.Registry, id track.ID, key pipeline.Key, ctx context.Context, rerr *error) {
	if (rerr == nil || *rerr == nil) && ctx.Err() == nil {
		return
	}
	msg := ""
	if rerr != nil && *rerr != nil {
		msg = (*rerr).Error()
	} else if ce := ctx.Err(); ce != nil {
		msg = "context cancelled: " + ce.Error()
	}
	if err := reg.SetStage(context.WithoutCancel(ctx), id, key, pipeline.StatusFailed, nil, msg); err != nil && rerr != nil {
		*rerr = errors.Join(*rerr, fmt.Errorf("record stage failure: %w", err))
	}
}
