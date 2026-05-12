package runpipeline

import (
	"testing"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
)

// upstreamOfCommitted is the gate that decides whether per-stage re-run
// must call RollbackIfCommitted before resetting the named stage. False
// for committed (no upstream), true for everything between ingest and
// reviewed.
func TestUpstreamOfCommitted(t *testing.T) {
	uc := UseCase{}
	cases := []struct {
		stage pipeline.Stage
		want  bool
	}{
		{pipeline.StageIngested, true},
		{pipeline.StageNormalized, true},
		{pipeline.StageMetadataExtracted, true},
		{pipeline.StageTranscribed, true},
		{pipeline.StageReviewed, true},
		{pipeline.StageCommitted, false},
		{pipeline.Stage("garbage"), false},
		{pipeline.Stage(""), false},
	}
	for _, c := range cases {
		got := uc.upstreamOfCommitted(c.stage)
		if got != c.want {
			t.Errorf("upstreamOfCommitted(%q) = %v, want %v", c.stage, got, c.want)
		}
	}
}

// Options.Only is a syntactic shortcut for "From=Only AND UpTo=Only".
// Run() normalises Only into From + UpTo at the top of the function, so
// any downstream code only has to handle From / UpTo.
//
// We can't test Run() end-to-end without the per-stage UCs being
// interfaces (they're concrete structs today; mocking would mean a
// separate refactor). What's testable in isolation is the canonical Op
// validity table — pinning the v2 surface against accidental rename.
func TestPipelineOpsAreStable(t *testing.T) {
	want := map[pipeline.Op]bool{
		pipeline.OpPipeline:      true,
		pipeline.OpAudioTag:      true,
		pipeline.OpAlignPDF:      true,
		pipeline.OpAudit:         true,
		pipeline.OpTitlesRefresh: true,
		pipeline.Op("nonsense"):  false,
		pipeline.Op(""):          false,
	}
	for op, ok := range want {
		got := pipeline.IsValidOp(op)
		if got != ok {
			t.Errorf("IsValidOp(%q) = %v, want %v", op, got, ok)
		}
	}
}

// String values of the Op constants are part of the v2 wire surface —
// renaming any of them is a breaking change that requires a major
// version bump and tool-name renumber.
func TestOpStringValues(t *testing.T) {
	want := map[pipeline.Op]string{
		pipeline.OpPipeline:      "pipeline",
		pipeline.OpAudioTag:      "audio_tag",
		pipeline.OpAlignPDF:      "align_pdf",
		pipeline.OpAudit:         "audit",
		pipeline.OpTitlesRefresh: "titles_refresh",
	}
	for op, expected := range want {
		if string(op) != expected {
			t.Errorf("Op string drift: %q has wire value %q, want %q",
				expected, string(op), expected)
		}
	}
}
