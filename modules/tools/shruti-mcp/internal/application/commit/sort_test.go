package commit

import (
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func TestBuildSortReference(t *testing.T) {
	cases := []struct {
		name         string
		refs         []catalog.TrackReference
		primaryShort string
		want         *string
	}{
		{"empty refs returns nil", nil, "", nil},
		{"empty refs ignores prefix", nil, "BG", nil},
		{"single 10.5 BG ru", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5"}}, "БГ", strPtr("БГ_000010_000005")},
		{"single 10.5 BG en", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5"}}, "BG", strPtr("BG_000010_000005")},
		{"deep 10.5.12", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5.12"}}, "BG", strPtr("BG_000010_000005_000012")},
		{"long token kept", []catalog.TrackReference{{SourceID: "source_SB", Tokens: "1234567"}}, "SB", strPtr("SB_1234567")},
		{"only first ref counts", []catalog.TrackReference{
			{SourceID: "source_BG", Tokens: "10.5"},
			{SourceID: "source_SB", Tokens: "1.1"},
		}, "BG", strPtr("BG_000010_000005")},
		{"empty tokens still gets prefix", []catalog.TrackReference{{SourceID: "source_BG", Tokens: ""}}, "BG", strPtr("BG")},
		{"empty prefix falls back to numeric tail", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "1.1"}}, "", strPtr("000001_000001")},
	}
	for _, c := range cases {
		got := buildSortReference(c.refs, c.primaryShort)
		if !strPtrEq(got, c.want) {
			t.Errorf("%s: got %s want %s", c.name, fmtStrPtr(got), fmtStrPtr(c.want))
		}
	}
}

// Lexicographic ordering: locale prefix buckets sources, padded numeric
// tail orders within. Cyrillic alphabet:  БГ < ШБ < ЧЧ. Verses inside a
// source: 1.1 < 1.2 < 1.10 < 2.1 (zero-pad makes 10 sort after 2).
func TestSortReferenceLexicographic(t *testing.T) {
	in := []struct {
		ref          catalog.TrackReference
		primaryShort string
	}{
		{catalog.TrackReference{SourceID: "source_SB", Tokens: "1.1"}, "ШБ"},
		{catalog.TrackReference{SourceID: "source_BG", Tokens: "2.1"}, "БГ"},
		{catalog.TrackReference{SourceID: "source_BG", Tokens: "1.10"}, "БГ"},
		{catalog.TrackReference{SourceID: "source_BG", Tokens: "1.1"}, "БГ"},
		{catalog.TrackReference{SourceID: "source_BG", Tokens: "1.2"}, "БГ"},
	}
	keys := make([]string, len(in))
	for i, r := range in {
		got := buildSortReference([]catalog.TrackReference{r.ref}, r.primaryShort)
		if got == nil {
			t.Fatalf("position %d: unexpected nil", i)
		}
		keys[i] = *got
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[i] > keys[j] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	want := []string{
		"БГ_000001_000001",
		"БГ_000001_000002",
		"БГ_000001_000010",
		"БГ_000002_000001",
		"ШБ_000001_000001",
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Errorf("position %d: got %q want %q", i, keys[i], want[i])
		}
	}
}

func strPtr(s string) *string { return &s }

func strPtrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func fmtStrPtr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return `"` + *p + `"`
}
