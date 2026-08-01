package domain_test

import (
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// One row per verse, matching what the corpus does with the same filenames.
func TestExpandRefs(t *testing.T) {
	cases := []struct {
		source, tokens string
		want           []string
	}{
		{"BG", "2.13", []string{"2.13"}},
		{"БГ", "02.23-24", []string{"2.23", "2.24"}},
		{"bg", "1.18-20", []string{"1.18", "1.19", "1.20"}},
		{"SB", "01.02.10", []string{"1.2.10"}},
		{"SB", "3", []string{"3"}},
		{"CC_MADHYA", "20.108", []string{"20.108"}},
		// Nothing readable as a range is left exactly as it came, rather than
		// silently dropped.
		{"BG", "2.13-x", []string{"2.13-x"}},
		{"BG", "5-3", []string{"5-3"}},
	}

	for _, c := range cases {
		refs, _ := domain.ExpandRefs(c.source, c.tokens)
		if len(refs) != len(c.want) {
			t.Errorf("%s %s: %d refs, want %d (%v)", c.source, c.tokens, len(refs), len(c.want), refs)
			continue
		}
		for i, ref := range refs {
			if ref.Tokens != c.want[i] {
				t.Errorf("%s %s: ref %d = %q, want %q", c.source, c.tokens, i, ref.Tokens, c.want[i])
			}
		}
	}
}

// A range nobody could have lectured on collapses to its first verse: the
// recording stays findable without dragging in sixty citations nobody made.
func TestExpandRefsCollapsesAnImplausibleRange(t *testing.T) {
	refs, note := domain.ExpandRefs("BG", "1.18-78")
	if len(refs) != 1 || refs[0].Tokens != "1.18" {
		t.Errorf("refs = %+v, want just BG 1.18", refs)
	}
	if note == "" {
		t.Error("collapsing must be reported, not silent")
	}
}

// Forty verses is an ordinary subject for one talk, and expands in full.
func TestExpandRefsAcceptsALongButRealRange(t *testing.T) {
	refs, note := domain.ExpandRefs("BG", "2.13-51")
	if note != "" {
		t.Fatalf("note = %q", note)
	}
	if len(refs) != 39 || refs[0].Tokens != "2.13" || refs[38].Tokens != "2.51" {
		t.Errorf("refs = %d, running %q..%q", len(refs), refs[0].Tokens, refs[len(refs)-1].Tokens)
	}
}

// A real range is short, and still expands.
func TestExpandRefsAcceptsARealRange(t *testing.T) {
	refs, complaint := domain.ExpandRefs("BG", "2.23-24")
	if complaint != "" {
		t.Fatalf("complaint = %q", complaint)
	}
	if len(refs) != 2 || refs[0].Tokens != "2.23" || refs[1].Tokens != "2.24" {
		t.Errorf("refs = %+v", refs)
	}
}

func TestExpandRefsNeedsASource(t *testing.T) {
	if refs, _ := domain.ExpandRefs("", "1.1"); refs != nil {
		t.Errorf("= %v, want nil", refs)
	}
}

func TestRefLabel(t *testing.T) {
	if got := (domain.Ref{Source: "SB", Tokens: "1.2.10"}).Label(); got != "SB 1.2.10" {
		t.Errorf("= %q", got)
	}
}
