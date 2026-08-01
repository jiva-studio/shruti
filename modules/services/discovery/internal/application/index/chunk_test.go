package index_test

import (
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/application/index"
)

func TestChunksSplitsOnLines(t *testing.T) {
	var sb strings.Builder
	for range 20 {
		sb.WriteString(strings.Repeat("word ", 30))
		sb.WriteByte('\n')
	}
	chunks := index.Chunks(sb.String())

	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want several", len(chunks))
	}
	for i, c := range chunks {
		if n := len([]rune(c)); n > 1200 {
			t.Errorf("chunk %d is %d runes", i, n)
		}
		if strings.TrimSpace(c) == "" {
			t.Errorf("chunk %d is blank", i)
		}
	}
}

func TestChunksKeepsShortTextWhole(t *testing.T) {
	chunks := index.Chunks("A talk given in Vrindavan.\nOn the nature of the soul.")
	if len(chunks) != 1 {
		t.Fatalf("chunks = %d, want 1", len(chunks))
	}
	if !strings.Contains(chunks[0], "Vrindavan") || !strings.Contains(chunks[0], "soul") {
		t.Errorf("chunk lost text: %q", chunks[0])
	}
}

func TestChunksHandlesEmpty(t *testing.T) {
	if got := index.Chunks("   \n \n "); got != nil {
		t.Errorf("= %v, want nil", got)
	}
}

// A line longer than a whole chunk still has to be searchable rather than
// dropped or left to swamp everything batched with it.
func TestChunksSplitsAnOverlongLine(t *testing.T) {
	chunks := index.Chunks(strings.Repeat("verylongword ", 400))
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want several", len(chunks))
	}
	for i, c := range chunks {
		if n := len([]rune(c)); n > 1200 {
			t.Errorf("chunk %d is %d runes", i, n)
		}
	}
}
