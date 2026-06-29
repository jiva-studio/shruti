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

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
)

// MarkOnExit writes StatusFailed when rerr is non-nil OR ctx has been
// cancelled. Uses context.Background() for the SetStage call so we can
// still record failure when the caller's ctx is already done.
func MarkOnExit(reg lakeport.Registry, id track.Id, key pipeline.Key, ctx context.Context, rerr *error) {
	if (rerr == nil || *rerr == nil) && ctx.Err() == nil {
		return
	}
	msg := ""
	if rerr != nil && *rerr != nil {
		msg = (*rerr).Error()
	} else if ce := ctx.Err(); ce != nil {
		msg = "context cancelled: " + ce.Error()
	}
	_ = reg.SetStage(context.Background(), id, key, pipeline.StatusFailed, nil, msg)
}
