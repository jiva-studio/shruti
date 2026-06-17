// Package run is the domain value object that captures one async
// operation submitted via the MCP layer — a pipeline batch, a publish,
// a per-track tool invoked with async=true, etc. The runregistry port
// owns persistence and lookup; this package owns the shape and the
// state transitions.
package run

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

// Kind labels the operation a Run represents. Open enum: new long-running
// tools register their own kind. Sticking to short snake_case.
type Kind string

const (
	KindPipeline           Kind = "pipeline"
	KindPublish            Kind = "publish"
	KindAudioTag           Kind = "audio_tag"
	KindAlignPDF           Kind = "align_pdf"
	KindAudit              Kind = "audit"
	KindTitlesRefresh      Kind = "titles_refresh"
	KindTranscriptReview   Kind = "transcript_review"
	KindTranscriptCreate   Kind = "transcript_create"
	KindAudioNormalize     Kind = "audio_normalize"
	KindAudioDenoise       Kind = "audio_denoise"
	KindTranscriptAlignPDF Kind = "transcript_align_pdf"
	KindTranscriptOutline  Kind = "transcript_outline"
	KindLibraryImport      Kind = "library_import"
	KindTopicsBuild        Kind = "topics_build"
	KindTopicsAssign       Kind = "topics_assign"
	KindTopicCovers        Kind = "topic_covers"
)

// Long-running per-track tools (transcript_review, transcript_create,
// audio_normalize, transcript_align_pdf) dispatch through the runner so
// MCP clients aren't held hostage to chunk-by-chunk latency. Short
// per-track tools (track.status, track.metadata.set, track.audio.tag,
// track.validate, track.commit) stay sync — they finish well under the
// MCP RPC budget.

// State is the run's lifecycle position. Allowed transitions:
//
//	queued    → running, cancelled
//	running   → done, failed, cancelled
//	done/failed/cancelled → terminal
type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateDone      State = "done"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
)

// IsTerminal reports whether s is a sink state — once a run hits one,
// the registry stops mutating its progress.
func (s State) IsTerminal() bool {
	switch s {
	case StateDone, StateFailed, StateCancelled:
		return true
	}
	return false
}

// Progress captures live counters surfaced via run_status.
//
//	FilesTotal  / FilesDone — for batch runs that map onto N target files.
//	StageBreakdown          — for kind=pipeline: how many targets are at
//	                          each stage. Empty for non-pipeline runs.
//	Message                 — short human-readable status note ("uploading
//	                          config.json", "queued behind 3 prior batches").
type Progress struct {
	FilesTotal     int            `json:"files_total"`
	FilesDone      int            `json:"files_done"`
	FilesFailed    int            `json:"files_failed"`
	StageBreakdown map[string]int `json:"stage_breakdown,omitempty"`
	Message        string         `json:"message,omitempty"`
}

// Run is the top-level value. Stays JSON-friendly so the runregistry
// layer can persist it as-is (in-memory v1; SQLite v2). Selector is
// nullable because some kinds (per-track sync wrappers turned async)
// don't have a selector.
type Run struct {
	Id          string          `json:"id"`
	Kind        Kind            `json:"kind"`
	State       State           `json:"state"`
	StartedAt   time.Time       `json:"started_at"`
	FinishedAt  time.Time       `json:"finished_at,omitempty"`
	Selector    *track.Selector `json:"selector,omitempty"`
	Targets     []string        `json:"targets,omitempty"`
	Progress    Progress        `json:"progress"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
	Cancellable bool            `json:"cancellable"`
}

// New constructs a Run in StateQueued with StartedAt=now. Caller fills
// Selector / Targets / Cancellable before submitting.
func New(id string, kind Kind) Run {
	return Run{
		Id:        id,
		Kind:      kind,
		State:     StateQueued,
		StartedAt: time.Now().UTC(),
	}
}

// Transition validates a state change and returns the resulting Run.
// Mutates a copy — Run is treated as immutable per registry update step.
func (r Run) Transition(to State) (Run, error) {
	if !canTransition(r.State, to) {
		return r, fmt.Errorf("run %s: %s → %s not allowed", r.Id, r.State, to)
	}
	out := r
	out.State = to
	if to.IsTerminal() {
		out.FinishedAt = time.Now().UTC()
	}
	return out, nil
}

func canTransition(from, to State) bool {
	switch from {
	case StateQueued:
		return to == StateRunning || to == StateCancelled
	case StateRunning:
		return to == StateDone || to == StateFailed || to == StateCancelled
	}
	return false
}
