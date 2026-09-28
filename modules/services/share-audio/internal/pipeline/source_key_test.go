package pipeline

import (
	"errors"
	"strings"
	"testing"
)

func TestPrepare_RejectsASourceKeyThatLeavesItsPath(t *testing.T) {
	c := Cutter{
		Prefix:          "public/shares/audio",
		SourceKeyPrefix: "public/tracks/",
		MaxExcerptMs:    60_000,
	}
	for _, key := range []string{
		"public/tracks/../../private/backups/db.mp3",
		"public/tracks/t/../../private/x.mp3",
		"public/tracks/./t/a.mp3",
		"public/tracks//a.mp3",
		"public/tracks/a#b.mp3",
		"public/tracks/a?b.mp3",
		"public/tracks/%2e%2e/a.mp3",
		`public/tracks/a\..\b.mp3`,
		"public/tracks/t/a b.mp3",
		"public/tracks/t/a.wav",
	} {
		_, err := c.Prepare(t.Context(), Request{SourceKey: key, StartMs: 0, EndMs: 1000})
		if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "source_key") {
			t.Errorf("source_key %q: got %v, want a source_key validation error", key, err)
		}
	}
}

func TestPrepare_AcceptsASourceKeyOfTheExpectedShape(t *testing.T) {
	c := Cutter{
		Prefix:          "public/shares/audio",
		SourceKeyPrefix: "public/tracks/",
		MaxExcerptMs:    60_000,
	}
	for _, key := range []string{"public/tracks/track_aBC-123/audio/original.mp3", "public/tracks/t/audio/clean.v2.mp3"} {
		if _, err := c.Prepare(t.Context(), Request{SourceKey: key, StartMs: 0, EndMs: 1000}); err != nil {
			t.Errorf("source_key %q rejected: %v", key, err)
		}
	}
}
