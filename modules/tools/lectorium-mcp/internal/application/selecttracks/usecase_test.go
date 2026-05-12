package selecttracks

import (
	"context"
	"errors"
	"testing"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/trackselect"
)

// fakeSelector implements trackselect.Selector with whatever the test
// dictates. Lets the use case unit test focus on validation + delegation
// without spinning up a SQLite registry.
type fakeSelector struct {
	rows []trackselect.Selected
	err  error

	// captured is the last selector the caller passed in. Used to verify
	// the use case applies NewSelector defaults before delegating.
	captured *track.Selector
}

func (f *fakeSelector) Select(_ context.Context, sel track.Selector) ([]trackselect.Selected, error) {
	f.captured = &sel
	if f.err != nil {
		return nil, f.err
	}
	return f.rows, nil
}

func TestRunRejectsInvalidSelector(t *testing.T) {
	uc := UseCase{Selector: &fakeSelector{}}
	pdf := true
	_, err := uc.Run(context.Background(), track.Selector{
		Source: track.SourceLake,
		HasPDF: &pdf,
	})
	if err == nil {
		t.Fatal("expected error from NewSelector validation, got nil")
	}
}

func TestRunAppliesDefaults(t *testing.T) {
	fake := &fakeSelector{rows: []trackselect.Selected{}}
	uc := UseCase{Selector: fake}
	if _, err := uc.Run(context.Background(), track.Selector{}); err != nil {
		t.Fatal(err)
	}
	if fake.captured == nil {
		t.Fatal("Select not called")
	}
	if fake.captured.Source != track.SourceBoth {
		t.Errorf("Source default not applied: %q", fake.captured.Source)
	}
	if fake.captured.Limit != track.DefaultLimit {
		t.Errorf("Limit default not applied: %d", fake.captured.Limit)
	}
}

func TestRunReturnsNonNilEmptyOnNoMatches(t *testing.T) {
	uc := UseCase{Selector: &fakeSelector{rows: nil}}
	got, err := uc.Run(context.Background(), track.Selector{})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("got nil, want non-nil empty slice")
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestRunPropagatesSelectorError(t *testing.T) {
	want := errors.New("registry exploded")
	uc := UseCase{Selector: &fakeSelector{err: want}}
	_, err := uc.Run(context.Background(), track.Selector{})
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
}
