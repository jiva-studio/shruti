package normalize_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/normalize"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// The model is asked to read, not to be trusted. Everything here is a thing a
// model has actually offered and a check that catches it, and the shape of the
// answer matters: a field that fails is cleared, never corrected. An empty date
// costs a filter; a confidently wrong one costs whoever believes it.

var now = time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)

func codes() map[string]bool { return normalize.SourceCodeSet(normalize.DefaultSourceCodes) }

func TestImpossibleDatesAreCleared(t *testing.T) {
	for _, date := range []string{
		"2035-01-01", // beyond next year: a talk not yet given
		"1782-04-01", // before recording existed
		"29.12.13",   // the archive's own format, not ours
		"2026-13-45",
		"soon",
	} {
		r := normalize.Result{Date: date}
		normalize.Validate(&r, codes(), now)
		if r.Date != "" {
			t.Errorf("%q survived as %q", date, r.Date)
		}
	}
}

func TestPlausibleDatesStay(t *testing.T) {
	for _, date := range []string{"1972-08-01", "2026-07-30", "2027-01-01"} {
		r := normalize.Result{Date: date}
		normalize.Validate(&r, codes(), now)
		if r.Date != date {
			t.Errorf("%q was cleared", date)
		}
	}
}

// A language is a two-letter code or it is nothing. "Sanskrit" and "English"
// are the model describing rather than answering.
func TestLanguageIsACodeOrNothing(t *testing.T) {
	for in, want := range map[string]string{
		"en": "en", "RU": "ru", "Hi": "hi",
		"english": "", "Sanskrit": "", "eng": "", "e": "", "": "",
	} {
		r := normalize.Result{Language: in}
		normalize.Validate(&r, codes(), now)
		if r.Language != want {
			t.Errorf("%q = %q, want %q", in, r.Language, want)
		}
	}
}

// A reference to a book outside the canon is an invention, not a citation, and
// citing something the corpus cannot address is worse than citing nothing.
func TestOnlyReferencesTheCorpusCanAddressSurvive(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{
		{Source: "bg", Tokens: "2.13"},
		{Source: "SB", Tokens: "1.2.10"},
		{Source: "QURAN", Tokens: "2.255"},
		{Source: "BG", Tokens: ""},
		{Source: "", Tokens: "2.13"},
	}}
	normalize.Validate(&r, codes(), now)

	if len(r.References) != 2 {
		t.Fatalf("kept %v", r.References)
	}
	// Case is settled here so that two spellings of one book are one filter.
	if r.References[0].Source != "BG" || r.References[1].Source != "SB" {
		t.Errorf("kept %v", r.References)
	}
}

// With no canon given, nothing is judged by it — the check is for a canon we
// have, not an excuse to drop what we cannot check.
func TestNoCanonMeansNoCanonCheck(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{{Source: "anything", Tokens: "1.1"}}}
	normalize.Validate(&r, nil, now)
	if len(r.References) != 1 || r.References[0].Source != "ANYTHING" {
		t.Errorf("= %v", r.References)
	}
}

func TestNegativeDurationBecomesUnknown(t *testing.T) {
	r := normalize.Result{DurationS: -42}
	normalize.Validate(&r, codes(), now)
	if r.DurationS != 0 {
		t.Errorf("= %d", r.DurationS)
	}
}

func TestSourceCodeSetIsCaseAndSpaceProof(t *testing.T) {
	set := normalize.SourceCodeSet([]string{" bg ", "Sb", "", "   "})
	if !set["BG"] || !set["SB"] {
		t.Errorf("= %v", set)
	}
	if len(set) != 2 {
		t.Errorf("blank codes became entries: %v", set)
	}
}

// Validating what a model got right must not change it.
func TestAGoodAnswerIsLeftAlone(t *testing.T) {
	r := normalize.Result{
		Title: "Bhagavad Gita 2.13", Author: "Radhanath Swami",
		Date: "2019-03-04", Language: "en", DurationS: 3600,
		References: []domain.Ref{{Source: "BG", Tokens: "2.13"}},
	}
	want := r
	normalize.Validate(&r, codes(), now)

	if r.Title != want.Title || r.Author != want.Author || r.Date != want.Date ||
		r.Language != want.Language || r.DurationS != want.DurationS ||
		len(r.References) != 1 {
		t.Errorf("got %+v, want %+v", r, want)
	}
}
