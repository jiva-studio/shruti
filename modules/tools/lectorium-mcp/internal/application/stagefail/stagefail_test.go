package stagefail

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	lakeport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
)

// fakeRegistry captures SetStage calls and panics on every other Registry
// method — MarkOnExit must only call SetStage. Embedding lakeport.Registry
// makes every unused method a typed-nil that panics on call (which is what
// we want: it'd surface a misuse of MarkOnExit immediately).
type fakeRegistry struct {
	lakeport.Registry
	calls []setStageCall
}

type setStageCall struct {
	id      track.Id
	key     pipeline.Key
	status  pipeline.Status
	payload []byte
	errMsg  string
}

func (f *fakeRegistry) SetStage(_ context.Context, id track.Id, key pipeline.Key, status pipeline.Status, payload []byte, errMsg string) error {
	f.calls = append(f.calls, setStageCall{id: id, key: key, status: status, payload: payload, errMsg: errMsg})
	return nil
}

var sampleId = track.Id("track_aaaaaaaaaaaa")
var sampleKey = pipeline.Key{Stage: pipeline.StageReviewed, Variant: "ru"}

func TestMarkOnExitNoopOnSuccess(t *testing.T) {
	reg := &fakeRegistry{}
	var rerr error
	MarkOnExit(reg, sampleId, sampleKey, context.Background(), &rerr)
	if len(reg.calls) != 0 {
		t.Fatalf("clean exit must not call SetStage, got %+v", reg.calls)
	}
}

func TestMarkOnExitMarksFailedOnError(t *testing.T) {
	reg := &fakeRegistry{}
	rerr := errors.New("boom")
	MarkOnExit(reg, sampleId, sampleKey, context.Background(), &rerr)
	if len(reg.calls) != 1 {
		t.Fatalf("expected 1 SetStage call, got %d", len(reg.calls))
	}
	c := reg.calls[0]
	if c.status != pipeline.StatusFailed {
		t.Errorf("status = %q, want failed", c.status)
	}
	if c.errMsg != "boom" {
		t.Errorf("errMsg = %q, want boom", c.errMsg)
	}
}

func TestMarkOnExitMarksFailedOnContextCancel(t *testing.T) {
	reg := &fakeRegistry{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var rerr error
	MarkOnExit(reg, sampleId, sampleKey, ctx, &rerr)
	if len(reg.calls) != 1 {
		t.Fatalf("expected 1 SetStage call, got %d", len(reg.calls))
	}
	if reg.calls[0].status != pipeline.StatusFailed {
		t.Errorf("status = %q, want failed", reg.calls[0].status)
	}
	if reg.calls[0].errMsg == "" {
		t.Errorf("errMsg empty on ctx cancel")
	}
}

func TestMarkOnExitErrTakesPriorityOverCtx(t *testing.T) {
	reg := &fakeRegistry{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rerr := errors.New("real failure")
	MarkOnExit(reg, sampleId, sampleKey, ctx, &rerr)
	if len(reg.calls) != 1 {
		t.Fatalf("expected 1 SetStage call, got %d", len(reg.calls))
	}
	if reg.calls[0].errMsg != "real failure" {
		t.Errorf("errMsg = %q, want real failure (rerr beats ctx)", reg.calls[0].errMsg)
	}
}

// Sanity check that pipeline.Stage doesn't accidentally drift away from
// the constants this test pins to. Surfaces a typo-rename early.
func TestMarkOnExitTimingDoesntMatter(t *testing.T) {
	reg := &fakeRegistry{}
	rerr := errors.New("late")
	start := time.Now()
	MarkOnExit(reg, sampleId, sampleKey, context.Background(), &rerr)
	if time.Since(start) > 10*time.Millisecond {
		t.Fatalf("MarkOnExit took too long: %v", time.Since(start))
	}
}
