package extract_test

import (
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/extract"
)

func TestTextSearchConfig(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"лекции о карме и реинкарнации", "russian"},
		{"lecture on karma and reincarnation in Mayapur", "english"},
		{"conferencia sobre el karma y la reencarnación", "spanish"},
		{"conférence sur le karma et la réincarnation", "french"},
		{"Vortrag über Karma und Reinkarnation", "german"},
		{"", "simple"},
		{"12345", "simple"},
		{"om namo bhagavate vasudevaya", "simple"},
	}

	for _, tt := range tests {
		got := extract.TextSearchConfig(tt.input)
		if got != tt.want {
			t.Errorf("TextSearchConfig(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
