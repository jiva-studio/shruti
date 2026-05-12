// Package selecttracks is the application-side wrapper around the
// trackselect.Selector port. It validates the requested Selector at the
// boundary (NewSelector) and delegates to the resolver. The MCP layer
// uses this for the tracks_select diagnostic tool, and pipeline_run /
// audit_review / tracks_*_bulk all call into the same use case to expand
// a selector into a concrete list of paths and ids.
package selecttracks

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/trackselect"
)

type UseCase struct {
	Selector trackselect.Selector
}

// Run validates the Selector via track.NewSelector (which applies
// defaults and rejects invariants like source=lake + has_pdf) then
// delegates to the resolver. Returns a non-nil empty slice when nothing
// matches — callers treat empty as "no candidates", not as an error.
func (uc UseCase) Run(ctx context.Context, in track.Selector) ([]trackselect.Selected, error) {
	sel, err := track.NewSelector(in)
	if err != nil {
		return nil, err
	}
	rows, err := uc.Selector.Select(ctx, sel)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []trackselect.Selected{}
	}
	return rows, nil
}
