// Package store persists a meeting's transcript and summary under
// ~/.local/share/shruti/meetings/<timestamp>/:
//
//	transcript.jsonl  one JSON line per final segment (channel + ts + text)
//	summary.md        the written summary
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// Meeting is an open on-disk meeting directory.
type Meeting struct {
	dir string
}

// dataHome returns the base meetings directory, honouring XDG_DATA_HOME.
func dataHome() (string, error) {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "shruti", "meetings"), nil
}

// NewMeeting creates a fresh timestamped meeting directory.
func NewMeeting(t time.Time) (*Meeting, error) {
	root, err := dataHome()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, t.Format("2006-01-02_15-04-05"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("store: create meeting dir: %w", err)
	}
	return &Meeting{dir: dir}, nil
}

// Dir returns the meeting directory path.
func (m *Meeting) Dir() string { return m.dir }

// WriteTranscript writes all final segments to transcript.jsonl (one per line).
func (m *Meeting) WriteTranscript(finals []v1.Update) error {
	f, err := os.Create(filepath.Join(m.dir, "transcript.jsonl"))
	if err != nil {
		return fmt.Errorf("store: create transcript: %w", err)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	for _, u := range finals {
		if err := enc.Encode(u); err != nil {
			return fmt.Errorf("store: write transcript line: %w", err)
		}
	}
	return nil
}

// WriteSummary writes the meeting summary to summary.md.
func (m *Meeting) WriteSummary(summary string) error {
	path := filepath.Join(m.dir, "summary.md")
	if err := os.WriteFile(path, []byte(summary), 0o644); err != nil {
		return fmt.Errorf("store: write summary: %w", err)
	}
	return nil
}
