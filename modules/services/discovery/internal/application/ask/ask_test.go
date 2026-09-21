package ask_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/ask"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
)

// The filter is one model in and out, so a caller can drop the year and keep
// the speaker without rewriting the sentence and hoping it reads the same way
// twice. These check what happens to it.

var now = time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)

func day(s string) *ask.Date {
	d, err := ask.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return &d
}

// reader answers with a fixed filter, and records what it was asked.
type reader struct {
	give   ask.Filter
	err    error
	asked  string
	toldAt time.Time
}

func (r *reader) Read(_ context.Context, q string, at time.Time) (ask.Filter, error) {
	r.asked, r.toldAt = q, at
	return r.give, r.err
}

// searcher records the query it was handed and answers with one hit.
type searcher struct {
	got     search.Query
	unknown bool
	calls   int
	// speakers is what the dictionary holds, by the spelling that finds them.
	speakers map[string]search.Speaker
	asked    []string
}

func (s *searcher) Search(_ context.Context, q search.Query) ([]search.Hit, error) {
	s.got, s.calls = q, s.calls+1
	return []search.Hit{{ItemID: 1, Title: "Talk"}}, nil
}

func (s *searcher) Names(_ context.Context, _ string) (bool, error) {
	return !s.unknown, nil
}

func (s *searcher) SpeakersNamed(_ context.Context, spellings, _ []string) ([]search.Speaker, error) {
	s.asked = spellings
	var out []search.Speaker
	for _, sp := range spellings {
		if who, ok := s.speakers[strings.ToLower(sp)]; ok {
			who.Spelling = sp
			out = append(out, who)
		}
	}
	return out, nil
}

func svc(r ask.Reader, s ask.Searcher) *ask.Service {
	return &ask.Service{Reader: r, Searcher: s, Now: func() time.Time { return now }}
}

func TestTheQuestionIsReadIntoTheFilter(t *testing.T) {
	r := &reader{give: ask.Filter{
		Authors: []string{"Шиварама Свами"}, DateFrom: day("2012-01-01"), DateTo: day("2012-12-31"),
	}}
	s := &searcher{}
	got, err := svc(r, s).Ask(t.Context(), "лекции Шиварамы Свами за 2012 год о карме", ask.Filter{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 1 || got.Filter.Authors[0] != "Шиварама Свами" {
		t.Errorf("authors = %v", got.Filter.Authors)
	}
	if got.Filter.DateFrom == nil || got.Filter.DateFrom.Year() != 2012 {
		t.Errorf("date_from = %v", got.Filter.DateFrom)
	}
	if got.Filter.Limit != 20 {
		t.Errorf("the caller's own field was lost: limit = %d", got.Filter.Limit)
	}
	if len(s.got.Authors) != 1 || s.got.Authors[0] != "Шиварама Свами" || s.got.Limit != 20 {
		t.Errorf("the search was handed %+v", s.got)
	}
	// The reading is told the date rather than reading a clock, or "за прошлый
	// год" cannot be tested and cannot be explained.
	if !r.toldAt.Equal(now) {
		t.Errorf("the reader was told %v, want %v", r.toldAt, now)
	}
}

// The question comes back exactly as it was asked. It is the caller's, and
// rewriting it is how a search box stops being one.
func TestTheQuestionComesBackUntouched(t *testing.T) {
	const q = "лекции Шиварамы Свами за 2012 год о карме"
	got, err := svc(&reader{give: ask.Filter{Authors: []string{"Шиварама Свами"}}}, &searcher{}).
		Ask(t.Context(), q, ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Question != q {
		t.Errorf("question came back as %q", got.Question)
	}
	// And it is what gets searched for: cutting the speaker out would be
	// second-guessing, and the author filter already narrows.
	if got.Filter.Text != q {
		t.Errorf("text = %q, want the question", got.Filter.Text)
	}
}

// The sentence wins over the filter, because the filter is what was set last
// time and the sentence is what is being said now. Every field it overrules is
// reported, so an interface can say so without diffing anything itself.
func TestTheQuestionOverrulesTheFilterAndSaysSo(t *testing.T) {
	got, err := svc(&reader{give: ask.Filter{DateFrom: day("2012-01-01")}}, &searcher{}).
		Ask(t.Context(), "за 2012 год", ask.Filter{DateFrom: day("2013-01-01")})
	if err != nil {
		t.Fatal(err)
	}
	if got.Filter.DateFrom.Year() != 2012 {
		t.Errorf("date_from = %v, want the question's", got.Filter.DateFrom)
	}
	var told bool
	for _, m := range got.Messages {
		if m.Field == "date_from" && m.Kind == ask.KindOverruled {
			told = true
		}
	}
	if !told {
		t.Errorf("nothing said the year was overruled: %+v", got.Messages)
	}
}

// A field the question says nothing about is left alone.
func TestWhatTheQuestionDoesNotSayIsKept(t *testing.T) {
	got, err := svc(&reader{give: ask.Filter{Authors: []string{"Локанатха Свами"}}}, &searcher{}).
		Ask(t.Context(), "лекции Локанатхи Свами", ask.Filter{Languages: []string{"ru"}, Sources: []string{"audioveda"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Languages) != 1 || got.Filter.Languages[0] != "ru" ||
		len(got.Filter.Sources) != 1 || got.Filter.Sources[0] != "audioveda" {
		t.Errorf("= %+v", got.Filter)
	}
	if len(got.Messages) != 0 {
		t.Errorf("nothing was overruled, yet: %+v", got.Messages)
	}
}

// A speaker the corpus does not hold keeps its filter and answers empty, and
// says which of the two empties it is. Widening somebody's search unasked is
// not this service's decision; leaving them unable to tell "no such lecture"
// from "no such person" is not an option either.
func TestAnUnknownSpeakerAnswersEmptyAndSaysWhy(t *testing.T) {
	s := &searcher{unknown: true}
	got, err := svc(&reader{give: ask.Filter{Authors: []string{"Кто-то Свами"}}}, s).
		Ask(t.Context(), "лекции Кого-то Свами", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Hits) != 0 {
		t.Errorf("%d hits for a speaker nobody has", len(got.Hits))
	}
	if s.calls != 0 {
		t.Error("the search ran anyway")
	}
	if len(got.Filter.Authors) != 1 || got.Filter.Authors[0] != "Кто-то Свами" {
		t.Errorf("the filter was quietly dropped: %+v", got.Filter)
	}
	var said bool
	for _, m := range got.Messages {
		if m.Kind == ask.KindMatchesNobody && m.Field == "authors" {
			said = true
		}
	}
	if !said {
		t.Errorf("an empty list with no reason: %+v", got.Messages)
	}
}

// Without a reader the question is still a search.
func TestWithoutAReaderTheQuestionIsSearchedAsWritten(t *testing.T) {
	s := &searcher{}
	got, err := (&ask.Service{Searcher: s, Now: func() time.Time { return now }}).
		Ask(t.Context(), "лекции о карме", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if s.got.Text != "лекции о карме" {
		t.Errorf("search text = %q", s.got.Text)
	}
	if len(got.Messages) != 1 || got.Messages[0].Kind != ask.KindNotRead {
		t.Errorf("= %+v", got.Messages)
	}
}

// A reading that failed is not a search that failed. Somebody is waiting.
func TestAFailedReadingStillSearches(t *testing.T) {
	s := &searcher{}
	got, err := svc(&reader{err: errors.New("provider said no")}, s).
		Ask(t.Context(), "лекции о карме", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Hits) != 1 {
		t.Errorf("%d hits", len(got.Hits))
	}
	if len(got.Messages) != 1 || got.Messages[0].Kind != ask.KindNotRead {
		t.Errorf("= %+v", got.Messages)
	}
}

// A filter with no question is the plain search, in a body — no model is asked
// anything.
func TestAFilterWithoutAQuestionAsksNobody(t *testing.T) {
	r := &reader{}
	s := &searcher{}
	if _, err := svc(r, s).Ask(t.Context(), "", ask.Filter{Authors: []string{"Локанатха Свами"}}); err != nil {
		t.Fatal(err)
	}
	if r.asked != "" {
		t.Errorf("the model was asked %q", r.asked)
	}
	if len(s.got.Authors) != 1 || s.got.Authors[0] != "Локанатха Свами" {
		t.Errorf("= %+v", s.got)
	}
}

// "BG 2.13" is how a person writes it; the columns hold the halves apart.
func TestAReferenceIsSplitForTheColumns(t *testing.T) {
	s := &searcher{}
	if _, err := svc(&reader{give: ask.Filter{Ref: "BG 2.13"}}, s).
		Ask(t.Context(), "лекции по БГ 2.13", ask.Filter{}); err != nil {
		t.Fatal(err)
	}
	if sourcesOf(s.got) != "BG" || s.got.Tokens != "2.13" {
		t.Errorf("ref = %q / %q", sourcesOf(s.got), s.got.Tokens)
	}
}

func sourcesOf(q search.Query) string {
	if len(q.Sources) == 0 {
		return ""
	}
	return q.Sources[0]
}

// A reference is read with the canon. "CC Madhya 8.128" is how a person writes
// it and "Бхагавад-гита 2.13" is how another does; cutting on the space found
// neither, while the corpus held both.
func TestAReferenceIsReadTheWayPeopleWriteIt(t *testing.T) {
	for _, c := range []struct{ ref, source, tokens string }{
		{"CC Madhya 8.128", "CC_MADHYA", "8.128"},
		{"CC_MADHYA 8.128", "CC_MADHYA", "8.128"},
		{"Бхагавад-гита 2.13", "BG", "2.13"},
		{"БГ 2.13", "BG", "2.13"},
		{"Шримад Бхагаватам 1.2.10", "SB", "1.2.10"},
	} {
		s := &searcher{}
		if _, err := (&ask.Service{Searcher: s, Now: func() time.Time { return now }}).
			Ask(t.Context(), "", ask.Filter{Ref: c.ref}); err != nil {
			t.Fatal(err)
		}
		if sourcesOf(s.got) != c.source || s.got.Tokens != c.tokens {
			t.Errorf("%q searched for %v %q, want %s %s",
				c.ref, s.got.Sources, s.got.Tokens, c.source, c.tokens)
		}
	}
}

// A reading that did not arrive still leaves the question saying what it says.
// A verse is in the words, and finding it costs nothing.
func TestAVerseSurvivesAReadingThatFailed(t *testing.T) {
	s := &searcher{}
	svc := &ask.Service{
		Searcher: s,
		Reader:   &reader{err: errors.New("provider was slow")},
		Now:      func() time.Time { return now },
	}
	got, err := svc.Ask(t.Context(), "что читали по Бхагавад-гите 2.13", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Filter.Ref != "BG 2.13" {
		t.Errorf("ref = %q; the question said it plainly", got.Filter.Ref)
	}
	if sourcesOf(s.got) != "BG" || s.got.Tokens != "2.13" {
		t.Errorf("searched for %v %q", s.got.Sources, s.got.Tokens)
	}
}

// "карма ватсала" is a topic and half a name. The reader does not call
// "ватсала" a speaker — it has no form of address beside it, and 74% of the
// people this corpus holds are stored without one — so nothing looked him up
// and his recordings were nowhere in the answer. Nothing in the corpus carries
// both words either, so no amount of text matching reaches him: only the
// dictionary does.
func TestANameWithNoFormOfAddressIsStillFound(t *testing.T) {
	dictionary := map[string]search.Speaker{
		// Measured on the corpus: two recordings of his own against two
		// mentions elsewhere.
		"ватсала": {Name: "Ватсала дас", Own: 2, Other: 2},
		// And a word that is a deity far more often than a speaker.
		"кришна": {Name: "Krishna", Own: 4, Other: 284},
		// A name nobody could mistake for a word.
		"парататтва": {Name: "Парататтва дас", Own: 135, Other: 29},
	}

	// Sure enough to narrow by.
	s := &searcher{speakers: dictionary}
	got, err := svc(&reader{}, s).Ask(t.Context(), "парататтва о терпении", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 1 || got.Filter.Authors[0] != "Парататтва дас" {
		t.Errorf("authors = %v, want the speaker the words name", got.Filter.Authors)
	}

	// Sure enough to mention, not to narrow by: the answer keeps whatever it
	// found and says his name beside it.
	s = &searcher{speakers: dictionary}
	got, err = svc(&reader{}, s).Ask(t.Context(), "карма ватсала", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 0 {
		t.Errorf("narrowed to %v on two recordings against two mentions", got.Filter.Authors)
	}
	if len(got.Hits) == 0 {
		t.Error("the topical answer was thrown away")
	}
	var offered bool
	for _, m := range got.Messages {
		if m.Kind == ask.KindDidYouMean && strings.Contains(m.Text, "Ватсала дас") {
			offered = true
		}
	}
	if !offered {
		t.Errorf("he was not offered: %+v", got.Messages)
	}

	// And a word that is a deity is left alone entirely.
	s = &searcher{speakers: dictionary}
	got, err = svc(&reader{}, s).Ask(t.Context(), "кто такой Кришна", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 0 || len(got.Messages) != 0 {
		t.Errorf("four recordings against two hundred mentions became %v / %+v",
			got.Filter.Authors, got.Messages)
	}
}

// Inside almost every real name there is a false one: "Krishna Hari das" holds
// a "Krishna" with four recordings and six hundred mentions. The longest run of
// words wins and the shorter ones inside it are dropped.
func TestTheLongestNameWins(t *testing.T) {
	s := &searcher{speakers: map[string]search.Speaker{
		"krishna hari": {Name: "Krishna Hari", Own: 128, Other: 0},
		"krishna":      {Name: "Krishna", Own: 4, Other: 643},
	}}
	got, err := svc(&reader{}, s).Ask(t.Context(), "krishna hari das on humility", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 1 || got.Filter.Authors[0] != "Krishna Hari" {
		t.Errorf("authors = %v, want Krishna Hari", got.Filter.Authors)
	}
}

// A speaker the reader did name is the reader's to name. The dictionary only
// speaks when nobody else has.
func TestTheDictionaryDoesNotOverruleTheReader(t *testing.T) {
	s := &searcher{speakers: map[string]search.Speaker{
		"парататтва": {Name: "Парататтва дас", Own: 135, Other: 29},
	}}
	r := &reader{give: ask.Filter{Authors: []string{"Шиварама Свами"}}}
	got, err := svc(r, s).Ask(t.Context(), "парататтва о терпении", ask.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Filter.Authors) != 1 || got.Filter.Authors[0] != "Шиварама Свами" {
		t.Errorf("authors = %v; the reader had already answered", got.Filter.Authors)
	}
	if len(s.asked) != 0 {
		t.Errorf("the dictionary was consulted anyway: %v", s.asked)
	}
}
