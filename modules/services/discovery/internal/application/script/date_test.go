package script_test

import (
	"context"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
)

// Every case here is a filename the archive actually carries.
func TestReadsTheDatesTheArchiveWrites(t *testing.T) {
	cases := []struct {
		filename string
		date     string
		complete bool
	}{
		{"2015-02-18_SB_08-22-20_-_Bhadra_Pr_Los_Angeles.mp3", "2015-02-18", true},
		// Both halves under thirteen, so day-month would also be a real date.
		// A four-digit year still settles it: this is not a coin-flip.
		{"Amal_Bhakta_Sw_CC_Madhya_Lila_13_-_2018-08-04_Los_Angeles.mp3", "2018-08-04", true},
		// "rus" is a word this archive uses and the script does not know, so the
		// remainder comes in two pieces and the file honestly goes to the model.
		{"BVG_rus_23-05-2004_Suharevo_Nagrajdenie.mp3", "2004-05-23", false},
		// Both readings are real dates. The archive's habit decides: measured
		// over its filenames, year-month-day beats day-month-year 2984 to 158.
		{"06-01-05-Srimad_Bhagavatam-5-18-11_Surrendering.mp3", "2006-01-05", true},
		// The second group is over twelve, so it cannot be a month: only one
		// reading survives and nothing is being guessed.
		// The speaker on this page is somebody else, so "BhaktiVasudeva" stays
		// unclaimed and splits the remainder. The date is still read correctly,
		// which is what this case is about.
		{"BhaktiVasudeva_Sw_SB_03-31-22_-_The_pains_-_2008-29-10.mp3", "2008-10-29", false},
		// A year on its own is a year, and the first of January is a placeholder
		// the corpus already understands.
		{"SGP_Krishna_Book_Tamil_-_1998.mp3", "1998-01-01", true},
		// No date at all is not a failure: the recording has none.
		{"Que_and_Ans_-_Brahmacari_and_Mind.mp3", "", true},
		// A coordinate is not a date. "SB 05-18-11" is the eighteenth chapter of
		// the fifth canto, and reads as a valid 11 May 2018 to anyone who takes
		// the numbers without the book in front of them.
		{"SKrishnaPr_SB_05-18-11.mp3", "", true},
	}

	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	page := script.Page{Path: []string{"02_-_ISKCON_Swamis", "His_Holiness_Test_Swami"}}

	for _, c := range cases {
		items := []script.Item{{URL: "https://x/" + c.filename, Filename: c.filename}}
		got, err := r.Run(context.Background(), "idt", page, items)
		if err != nil {
			t.Fatalf("%s: %v", c.filename, err)
		}
		f := got["https://x/"+c.filename]
		if f.Date != c.date {
			t.Errorf("%s\n  date = %q, want %q", c.filename, f.Date, c.date)
		}
		if f.Complete != c.complete {
			t.Errorf("%s\n  complete = %v, want %v (date %q)", c.filename, f.Complete, c.complete, f.Date)
		}
	}
}
