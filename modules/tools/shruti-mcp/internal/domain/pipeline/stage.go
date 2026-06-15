package pipeline

// Op discriminates the kind of work pipeline.run dispatches.
//
//   OpPipeline       — linear ingest → committed pipeline (default).
//   OpAudioTag       — re-tag mp3 ID3 tags for selected (track, language) pairs.
//   OpAlignPDF       — run PDF→ASR aligner (bulk replacement for tracks_align_pdf_bulk).
//   OpAudit          — corpus audit walk; aggregator output lands in run.Result.
//   OpTitlesRefresh  — LLM-rederive titles for selected (track, language) pairs.
//
// Only OpPipeline honours the linear stage progression (and the From/Only/UpTo
// options). The other ops are post-commit / cross-cutting operations and
// fan out per-(track, language) without touching the stage enum.
type Op string

const (
	OpPipeline      Op = "pipeline"
	OpAudioTag      Op = "audio_tag"
	OpAlignPDF      Op = "align_pdf"
	OpAudit         Op = "audit"
	OpTitlesRefresh Op = "titles_refresh"
	OpOutline       Op = "outline"
)

// IsValidOp reports whether s is one of the recognised Op values.
func IsValidOp(s Op) bool {
	switch s {
	case OpPipeline, OpAudioTag, OpAlignPDF, OpAudit, OpTitlesRefresh, OpOutline:
		return true
	}
	return false
}

// Stage is one step in the per-track lake pipeline.
type Stage string

const (
	StageIngested          Stage = "ingested"
	StageNormalized        Stage = "normalized"
	StageMetadataExtracted Stage = "metadata"
	StageTranscribed       Stage = "transcribed"
	StageReviewed          Stage = "reviewed"
	StageCommitted         Stage = "committed"
)

// Status of one stage.
type Status string

const (
	StatusPending Status = "pending"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// Key identifies a stage instance. Variant is "" for language-agnostic stages
// (ingest/normalize/metadata) and a language code for transcribe/review/commit.
type Key struct {
	Stage   Stage
	Variant string
}

// LanguageAgnostic returns true when this stage is not per-language.
func (s Stage) LanguageAgnostic() bool {
	switch s {
	case StageIngested, StageNormalized, StageMetadataExtracted:
		return true
	}
	return false
}

// Dependents returns the set of stages that must be reset to Pending whenever
// the given stage transitions to Done. variant of '' means "all variants".
//
// Cascade rules (mirrors plan):
//   ingest    → normalize, metadata, transcribe(*), review(*), commit(*)
//   normalize → metadata, transcribe(*), review(*), commit(*)
//   metadata  → commit(*)
//   transcribe(L) → review(L), commit(L)
//   review(L)     → commit(L)
//   commit(L)     → ()
//
// Stages that propagate to "all variants" return language-agnostic Key
// entries with Variant == "*"; the registry expands the wildcard against
// known languages for the track.
func Dependents(stage Stage) []Key {
	switch stage {
	case StageIngested:
		return []Key{
			{Stage: StageNormalized},
			{Stage: StageMetadataExtracted},
			{Stage: StageTranscribed, Variant: "*"},
			{Stage: StageReviewed, Variant: "*"},
			{Stage: StageCommitted, Variant: "*"},
		}
	case StageNormalized:
		return []Key{
			{Stage: StageMetadataExtracted},
			{Stage: StageTranscribed, Variant: "*"},
			{Stage: StageReviewed, Variant: "*"},
			{Stage: StageCommitted, Variant: "*"},
		}
	case StageMetadataExtracted:
		return []Key{
			{Stage: StageCommitted, Variant: "*"},
		}
	case StageTranscribed, StageReviewed:
		// Same-language only.
		return []Key{
			{Stage: nextStage(stage), Variant: "<self>"},
		}
	}
	return nil
}

func nextStage(s Stage) Stage {
	switch s {
	case StageTranscribed:
		return StageReviewed
	case StageReviewed:
		return StageCommitted
	}
	return ""
}
