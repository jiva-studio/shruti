package normalize

import (
	"regexp"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// earliestPlausible is before any recording of a lecture we index could exist.
var earliestPlausible = time.Date(1900, time.January, 1, 0, 0, 0, 0, time.UTC)

// verseToken is a coordinate and nothing else: dot-separated numbers, with an
// optional range on the last of them.
//
// Asked to read an unreadable name a model will sometimes answer with the
// topic — "NOD" / "Three levels of Devotees" — and a sentence in the column
// that holds "7.5.33" is not a weaker reference, it is a different kind of
// thing, and it matches nothing forever.
var verseToken = regexp.MustCompile(`^\d+(\.\d+)*(-\d+)?$`)

// Validate drops whatever a model said that we can check and find wrong, and
// returns what it dropped and why.
//
// The model is asked to read, not to be trusted. A field that fails a check is
// cleared rather than corrected: an empty date costs a filter, a confidently
// wrong one costs the person who believes it.
func Validate(r *Result, knownSources map[string]bool, now time.Time) []string {
	var notes []string
	if r.Date != "" {
		d, err := time.Parse("2006-01-02", r.Date)
		if err != nil || d.Before(earliestPlausible) || d.After(now.AddDate(1, 0, 0)) {
			r.Date = ""
		}
	}

	if len(r.Language) != 2 {
		r.Language = ""
	}
	r.Language = strings.ToLower(r.Language)

	// A fresh slice: expansion can yield more than it consumed, which writing
	// into r.References would overwrite.
	kept := make([]domain.Ref, 0, len(r.References))
	for _, ref := range r.References {
		if ref.Tokens == "" || ref.Source == "" {
			continue
		}
		// A book the model named rather than coded — "ШБ", "Бхагавад-гита",
		// "Sri Isopanisad". The canon already carries every spelling this
		// corpus writes, so the mapping belongs here and not in a prompt,
		// where it could not be tested.
		if !knownSources[strings.ToUpper(ref.Source)] {
			if src, ok := domain.SourceByName(ref.Source); ok {
				ref.Source = src.Code
			}
		}
		if len(knownSources) > 0 && !knownSources[strings.ToUpper(ref.Source)] {
			continue
		}
		if !verseToken.MatchString(strings.TrimSpace(ref.Tokens)) {
			continue
		}
		// A range is one entry in the answer and one row per verse in the
		// corpus: the filter that finds a talk is an exact match on a
		// coordinate, so "4.2.34-35" is a passage no verse in it can reach.
		expanded, note := domain.ExpandRefs(ref.Source, ref.Tokens)
		if note != "" {
			notes = append(notes, note)
		}
		kept = append(kept, expanded...)
	}
	r.References = kept
	return notes
}

// DefaultSourceCodes and SourceCodeSet moved to domain, where the canon
// belongs: it is knowledge about the corpus rather than about reading a page,
// and reading a question needs the same list.
var DefaultSourceCodes = domain.SourceCodes

// SourceCodeSet turns a code list into the lookup Validate wants.
func SourceCodeSet(codes []string) map[string]bool { return domain.SourceCodeSet(codes) }
