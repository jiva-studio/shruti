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
		Date: "2019-03-04", Language: "en",
		References: []domain.Ref{{Source: "BG", Tokens: "2.13"}},
	}
	want := r
	normalize.Validate(&r, codes(), now)

	if r.Title != want.Title || r.Author != want.Author || r.Date != want.Date ||
		r.Language != want.Language || len(r.References) != 1 {
		t.Errorf("got %+v, want %+v", r, want)
	}
}

// A model asked to read an unreadable name will sometimes answer with the
// topic — "NOD" / "Three levels of Devotees". A sentence in the column that
// holds "7.5.33" matches nothing, and goes on matching nothing.
func TestASentenceIsNotACoordinate(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{
		{Source: "NOD", Tokens: "Three levels of Devotees"},
		{Source: "SB", Tokens: "7.5.33"},
		{Source: "BG", Tokens: "chapter 2"},
	}}
	normalize.Validate(&r, codes(), now)

	if len(r.References) != 1 || r.References[0].Tokens != "7.5.33" {
		t.Errorf("kept %v", r.References)
	}
}

// A range is one entry in the answer and one row per verse in the corpus: the
// filter that finds a talk is an exact match on a coordinate, so a passage
// stored as "4.2.34-35" is one no verse inside it can reach.
func TestARangeBecomesItsVerses(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{{Source: "SB", Tokens: "4.2.34-35"}}}
	normalize.Validate(&r, codes(), now)

	if len(r.References) != 2 ||
		r.References[0].Tokens != "4.2.34" || r.References[1].Tokens != "4.2.35" {
		t.Errorf("= %v", r.References)
	}
}

// A source that names its book rather than coding it — "ШБ 1.2.10",
// "Бхагавад-гита 2.13". The canon carries every spelling the corpus writes, so
// the mapping is testable here rather than written into a prompt.
func TestABookNamedRatherThanCodedIsResolved(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{
		{Source: "ШБ", Tokens: "1.2.10"},
		{Source: "Бхагавад-гита", Tokens: "2.13"},
		{Source: "ЧЧ-Мадхйа", Tokens: "8.128"},
		{Source: "Sri Isopanisad", Tokens: "15"},
		{Source: "НП", Tokens: "4"},
		{Source: "Коран", Tokens: "2.255"},
	}}
	normalize.Validate(&r, codes(), now)

	var got []string
	for _, ref := range r.References {
		got = append(got, ref.Source+" "+ref.Tokens)
	}
	want := []string{"SB 1.2.10", "BG 2.13", "CC_MADHYA 8.128", "ISO 15", "NOD 4"}
	if len(got) != len(want) {
		t.Fatalf("= %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("= %v, want %v", got, want)
			break
		}
	}
}

// Expansion adds rows, so the references after a range must survive it.
func TestARangeDoesNotEatTheReferencesAfterIt(t *testing.T) {
	r := normalize.Result{References: []domain.Ref{
		{Source: "BG", Tokens: "2.23-24"},
		{Source: "SB", Tokens: "1.2.10"},
		{Source: "BG", Tokens: "9.26"},
	}}
	normalize.Validate(&r, codes(), now)

	want := []string{"2.23", "2.24", "1.2.10", "9.26"}
	if len(r.References) != len(want) {
		t.Fatalf("= %+v, want %v", r.References, want)
	}
	for i, w := range want {
		if r.References[i].Tokens != w {
			t.Errorf("ref %d = %q, want %q", i, r.References[i].Tokens, w)
		}
	}
}
