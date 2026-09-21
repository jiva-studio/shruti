package pipeline

import (
	"errors"
	"strings"
	"testing"
)

// The SourceKeyPrefix gate is the primary defence against anonymous
// callers fishing other prefixes out of the same bucket (the backup
// prefix being the worry that motivated the check). Storage is never
// touched on the rejection path, so a zero-value Cutter is enough.

func TestCut_RejectSourceKeyOutsidePrefix(t *testing.T) {
	c := Cutter{
		Prefix:          "public/shares/audio",
		SourceKeyPrefix: "public/tracks/",
		MaxExcerptMs:    60_000,
	}
	_, err := c.Cut(t.Context(), Request{
		SourceKey: "private/backups/postgres/2026-05-23.sql.gz",
		StartMs:   0,
		EndMs:     1000,
	})
	if err == nil {
		t.Fatalf("expected ErrValidation, got nil")
	}
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
	if !strings.Contains(err.Error(), "public/tracks/") {
		t.Errorf("error should name the expected prefix, got %v", err)
	}
}

func TestCut_AcceptsSourceKeyInsidePrefix(t *testing.T) {
	// Validation passes; we then hit the next failure (range) which
	// proves we got past the prefix gate without ever invoking Storage.
	c := Cutter{
		Prefix:          "public/shares/audio",
		SourceKeyPrefix: "public/tracks/",
		MaxExcerptMs:    60_000,
	}
	_, err := c.Cut(t.Context(), Request{
		SourceKey: "public/tracks/abc/audio/original.mp3",
		StartMs:   1000,
		EndMs:     0,
	})
	if err == nil {
		t.Fatalf("expected ErrValidation from range check, got nil")
	}
	if !strings.Contains(err.Error(), "end_ms") {
		t.Errorf("expected to reach range check; got %v", err)
	}
}

func TestCut_EmptyPrefixSkipsCheck(t *testing.T) {
	// An empty SourceKeyPrefix bypasses the gate (kept as an explicit
	// disable knob for tests / future migration). Validation must
	// therefore reach the next check even for an out-of-tree key.
	c := Cutter{
		Prefix:          "public/shares/audio",
		SourceKeyPrefix: "",
		MaxExcerptMs:    60_000,
	}
	_, err := c.Cut(t.Context(), Request{
		SourceKey: "anything/at/all.mp3",
		StartMs:   1000,
		EndMs:     0,
	})
	if err == nil || !strings.Contains(err.Error(), "end_ms") {
		t.Errorf("expected range-check error, got %v", err)
	}
}
