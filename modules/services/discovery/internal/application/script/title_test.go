package script_test

import (
	"context"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
)

// Every line here is one the archive actually carries, and each produced a
// title that was not one.
func TestTitleKeepsOnlyWhatIsATitle(t *testing.T) {
	page := script.Page{Path: []string{"06_-_More", "01_-_ISKCON_Mayapur", "2012"}}
	cases := []struct{ filename, want string }{
		// A speaker of four words: stopping the run short left "Bhakti" to pass
		// for the name of the talk.
		{"2012-01-06_SB_04-22-52_-_Bhakti_Vigna_Vinasa_Narsimha_Sw_ISKCON_Mayapur.mp3", ""},
		// A category written into the filename rather than the directory.
		{"2012-02-03_Festivals_-_Glories_of_Lord_Varahdev_-_Hari_Sauri_Pr_ISKCON_Mayapur.mp3",
			"Glories of Lord Varahdev"},
		// A number that begins a real name stays.
		{"2012-03-04_9_Best_Bhakti_Practices_-_Hari_Sauri_Pr_ISKCON_Mayapur.mp3",
			"9 Best Bhakti Practices"},
	}

	items := make([]script.Item, len(cases))
	for i, c := range cases {
		items[i] = script.Item{URL: "https://x/" + c.filename, Filename: c.filename}
	}
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Run(context.Background(), "idt", page, items)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if title := got["https://x/"+c.filename].Title; title != c.want {
			t.Errorf("%s\n  title = %q, want %q", c.filename, title, c.want)
		}
	}
}

// A festival page is all kirtans: the words every line shares are the archive
// counting its days, and the number left behind when "Day" goes is not a name.
func TestCountedDaysAreNotTitles(t *testing.T) {
	page := script.Page{Path: []string{"05_-_ISKCON_Chowpatty", "00_-_Kirtan_Fest", "2019"}}
	files := []string{
		"2019-01-11_Hare_Krishna_Kirtan_Day-01_-_Lokanath_Swami_ISKCON_Chowpatty.mp3",
		"2019-01-12_Hare_Krishna_Kirtan_Day-02_-_Goloknath_Prabhu_ISKCON_Chowpatty.mp3",
		"2019-01-13_Hare_Krishna_Kirtan_Day-03_-_Damodar_Hari_Prabhu_ISKCON_Chowpatty.mp3",
		"2019-01-14_Hare_Krishna_Kirtan_Day-04_-_Radha_Govind_Mataji_ISKCON_Chowpatty.mp3",
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
		if title := got["https://x/"+f].Title; title != "" {
			t.Errorf("%s\n  title = %q, want none", f, title)
		}
	}
}

// An archive that writes "Unknown" is not silent about the speaker — it is
// saying there is none. Treating that as a gap sends the line to a model that
// can only invent one, and the whole page of bhajans went that way.
func TestNamedAsNobodyIsAnAnswer(t *testing.T) {
	page := script.Page{Path: []string{"06_-_More", "01_-_ISKCON_Mayapur", "2011"}}
	files := []string{
		"2011-01-19_Bhajans_-_Hare_Krishna_Kirtan_-_Unknown_ISKCON_Mayapur.mp3",
		"2011-01-29_Bhajans_-_Hare_Krishna_Kirtan-01_-_Unknown_ISKCON_Mayapur.mp3",
		"2011-01-30_Bhajans_-_Gopi_Geet_-_Unknown_ISKCON_Mayapur.mp3",
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
		f := got["https://x/"+f]
		if !f.Complete {
			t.Errorf("%s: sent to the model although the archive said who spoke: nobody", f.URL)
		}
		if f.Author != "" {
			t.Errorf("%s: author = %q, want none", f.URL, f.Author)
		}
	}
}

// Babaji and Thakura are titles in their own right and stay in the name. They
// must not be folded into another: a Thakura written as a Devi Dasi would be
// both a different title and a different person.
func TestTitlesOfRenunciatesStay(t *testing.T) {
	for _, c := range []struct{ dir, want string }{
		{"His_Holiness_Bhaktisiddhanta_Sarasvati_Thakur", "Bhaktisiddhanta Sarasvati Thakura"},
		{"His_Holiness_Gaura_Kisora_Das_Babaji", "Gaura Kisora Das Babaji"},
		{"His_Grace_Bhakta_Shivahari", "Shivahari"},
	} {
		page := script.Page{Path: []string{"02_-_ISKCON_Swamis", c.dir}}
		got, err := mustRun(t, page, "Some_Recording.mp3")
		if err != nil {
			t.Fatal(err)
		}
		if got.Author != c.want {
			t.Errorf("%s\n  author = %q, want %q", c.dir, got.Author, c.want)
		}
	}
}

func mustRun(t *testing.T, page script.Page, file string) (script.Fields, error) {
	t.Helper()
	r, err := script.New()
	if err != nil {
		return script.Fields{}, err
	}
	got, err := r.Run(context.Background(), "idt", page,
		[]script.Item{{URL: "https://x/" + file, Filename: file}})
	if err != nil {
		return script.Fields{}, err
	}
	return got["https://x/"+file], nil
}

// Two rules that fired in the wrong place, both seen in search results.
func TestSectionWordsAndCatalogueYears(t *testing.T) {
	page := script.Page{Path: []string{"06_-_More", "05_-_Yatras"}}
	cases := []struct{ filename, want string }{
		// The archive shelves this one under its year and a running number, and
		// states the date again at the end. A year has never begun a title.
		{"1989_011_An_Empty_Husk_Lecture_-_Radhanath_Swami_Mumbai_1989-07-08.mp3", "An Empty Husk"},
	}
	items := make([]script.Item, len(cases))
	for i, c := range cases {
		items[i] = script.Item{URL: "https://x/" + c.filename, Filename: c.filename}
	}
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Run(context.Background(), "idt", page, items)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if title := got["https://x/"+c.filename].Title; title != c.want {
			t.Errorf("%s\n  title = %q, want %q", c.filename, title, c.want)
		}
	}
}
