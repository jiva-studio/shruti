package script_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

// What every line on a page repeats is the archive's stamp, not a title. What
// one line carries might be.
//
// This replaced a rule that judged a token by its shape — does "SNP" look like
// initials? — which had no right answer: loose enough to catch "SNP", it also
// took "DC" out of Washington DC.
func TestPageStampIsNotATitle(t *testing.T) {
	page := script.Page{Path: []string{"01_-_Srila_Prabhupada", "02_-_Bhajans"}}
	files := []string{
		"SP_Bhajans_-_Gurvastakam.mp3",
		"SP_Bhajans_-_Nrsimha_Prayers.mp3",
		"SP_Bhajans_-_Gopi_Geet.mp3",
		"SP_Bhajans_-_Damodarastakam_in_Washington_DC.mp3",
	}
	items := make([]script.Item, len(files))
	for i, f := range files {
		items[i] = script.Item{URL: "https://x/" + f, Filename: f}
	}

	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Run(context.Background(), "idt", page, items)
	if err != nil {
		t.Fatal(err)
	}

	for _, f := range files {
		title := got["https://x/"+f].Title
		// "SP" is on every line, so it is the stamp and belongs to none of them.
		if strings.Contains(title, "SP") {
			t.Errorf("%s: title %q still carries the page stamp", f, title)
		}
		if title == "" {
			t.Errorf("%s: title went missing entirely", f)
		}
	}

	// "DC" is on one line only, so it is part of what that line says.
	last := got["https://x/"+files[3]].Title
	if !strings.Contains(last, "DC") {
		t.Errorf("a word from a single line was taken as a stamp: %q", last)
	}
}
