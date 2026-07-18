// Package pendingport declares the ports the pending-queue use cases depend
// on, keeping the application layer decoupled from the sqlite adapter.
package pendingport

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pending"
)

// Reader is the read/consume surface the admin tools need over the fetched
// pending.db artifact.
type Reader interface {
	List(ctx context.Context, opts pending.ListOpts) ([]pending.Track, error)
	Get(ctx context.Context, trackID string) (pending.Track, bool, error)
	// MarkConsumed records that a pending row has been promoted (sets its
	// consumed_at), so the next producer pass can reconcile it. Idempotent;
	// returns ok=false if the row is unknown.
	MarkConsumed(ctx context.Context, trackID string) (bool, error)
}

// Verifier confirms a freshly-downloaded pending.db is a well-formed artifact
// before the refresh use case swaps it in — the pending-side analogue of
// catalogport.SchemeReader.
type Verifier interface {
	VerifyArtifact(ctx context.Context, dbPath string) error
}
