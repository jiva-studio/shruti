// Package commitport carries the narrow Rollbacker interface that ingest
// and runpipeline depend on so cascade-resets can purge stale current.db
// rows without ingest having to import the full commit application package.
//
// The commit.UseCase satisfies this interface as-is.
package commitport

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

type Rollbacker interface {
	// RollbackIfCommitted removes any committed (track, language) rows from
	// the catalog so a subsequent commit lands cleanly. No-op when nothing
	// was committed for `id`.
	RollbackIfCommitted(ctx context.Context, id track.Id) error
}
