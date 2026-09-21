// Package lake defines the port for the lake registry.
package lake

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

// StageRow is one row from the stages table.
type StageRow struct {
	TrackID    track.ID
	Key        pipeline.Key
	Status     pipeline.Status
	StartedAt  string
	FinishedAt string
	Error      string
	Payload    []byte
}

// FileRow describes one row from the files table joined with its stages.
type FileRow struct {
	Source track.SourceFile
	ID     track.ID
	Stages []StageRow
}

// Registry tracks the lake's path → trackID mapping and per-stage state.
type Registry interface {
	// UpsertFile inserts or refreshes a row by Path. Mints a new TrackID on
	// first sight; returns sha256Changed=true when the recorded SHA256
	// differs from src.SHA256 (caller must cascade-reset stages then).
	UpsertFile(ctx context.Context, src track.SourceFile) (id track.ID, sha256Changed bool, err error)

	LookupByPath(ctx context.Context, path string) (track.ID, bool, error)

	// LookupLanguage returns the per-file language stored at ingest time.
	// Empty string when the source is not under outbox/sorted/<lang>/.
	LookupLanguage(ctx context.Context, id track.ID) (string, error)

	// LookupPathByID returns the lake-in source path that minted this
	// track id (the path that was passed to ingest). Empty + nil error
	// when the id is unknown — caller chooses whether that's an error.
	LookupPathByID(ctx context.Context, id track.ID) (string, error)

	// SetStage records the new status for one (trackID, key). When status
	// transitions to Done, dependent stages are reset to Pending in the
	// same transaction (cascade rule per pipeline.Dependents).
	SetStage(ctx context.Context, id track.ID, key pipeline.Key, status pipeline.Status, payload []byte, errMessage string) error

	GetStage(ctx context.Context, id track.ID, key pipeline.Key) (StageRow, bool, error)

	ListAllStages(ctx context.Context, id track.ID) ([]StageRow, error)

	ListPending(ctx context.Context, stage pipeline.Stage) ([]FileRow, error)

	ResetStagesFor(ctx context.Context, id track.ID) error

	// ResetStageAndDependents wipes one stage row + every dependent stage
	// to Pending in a single transaction. Same dependent set used by the
	// cascade-on-Done rule (pipeline.Dependents). Used by per-stage
	// re-run flows in pipeline.run (op=pipeline only=<stage> | from=<stage>)
	// to avoid wiping upstream stages whose artifacts we want to keep.
	ResetStageAndDependents(ctx context.Context, id track.ID, key pipeline.Key) error

	// TryClaimStage atomically transitions Pending|Failed → Running.
	// Returns claimed=false if another caller already holds Running.
	TryClaimStage(ctx context.Context, id track.ID, key pipeline.Key) (claimed bool, err error)

	// MarkInterruptedAsFailed flips any Running rows to Failed on startup.
	MarkInterruptedAsFailed(ctx context.Context) (count int, err error)

	// Scan walks files in pages.
	Scan(ctx context.Context, limit int, cursor string) ([]FileRow, string, error)
}
