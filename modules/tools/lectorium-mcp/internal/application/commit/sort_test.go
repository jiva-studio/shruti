package commit

import (
	"testing"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

func TestBuildSortReference(t *testing.T) {
	cases := []struct {
		name         string
		refs         []catalog.TrackReference
		primaryShort string
		want         string
	}{
		{"empty refs", nil, "", "zzzzzz"},
		{"empty refs ignores prefix", nil, "BG", "zzzzzz"},
		{"single 10.5 BG ru", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5"}}, "БГ", "БГ_000010_000005"},
		{"single 10.5 BG en", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5"}}, "BG", "BG_000010_000005"},
		{"deep 10.5.12", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "10.5.12"}}, "BG", "BG_000010_000005_000012"},
		{"long token kept", []catalog.TrackReference{{SourceID: "source_SB", Tokens: "1234567"}}, "SB", "SB_1234567"},
		{"only first ref counts", []catalog.TrackReference{
			{SourceID: "source_BG", Tokens: "10.5"},
			{SourceID: "source_SB", Tokens: "1.1"},
		}, "BG", "BG_000010_000005"},
		{"empty tokens still gets prefix", []catalog.TrackReference{{SourceID: "source_BG", Tokens: ""}}, "BG", "BG"},
		{"empty prefix falls back to numeric tail", []catalog.TrackReference{{SourceID: "source_BG", Tokens: "1.1"}}, "", "000001_000001"},
	}
	for _, c := range cases {
		got := buildSortReference(c.refs, c.primaryShort)
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestBuildSortDate(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "00000000"},
		{"1974-10-20", "19741020"},
		{"2026-05-04", "20260504"},
		{"garbage", "00000000"},
		{"1974/10/20", "00000000"},
	}
	for _, c := range cases {
		got := buildSortDate(c.in)
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
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
		keys[i] = buildSortReference([]catalog.TrackReference{r.ref}, r.primaryShort)
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
