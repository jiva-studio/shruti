package normalize

import (
	"strings"
	"time"
)

// earliestPlausible is before any recording of a lecture we index could exist.
var earliestPlausible = time.Date(1900, time.January, 1, 0, 0, 0, 0, time.UTC)

// Validate drops whatever a model said that we can check and find wrong.
//
// The model is asked to read, not to be trusted. A field that fails a check is
// cleared rather than corrected: an empty date costs a filter, a confidently
// wrong one costs the person who believes it.
func Validate(r *Result, knownSources map[string]bool, now time.Time) {
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

	kept := r.References[:0]
	for _, ref := range r.References {
		if ref.Tokens == "" || ref.Source == "" {
			continue
		}
		if len(knownSources) > 0 && !knownSources[strings.ToUpper(ref.Source)] {
			continue
		}
		ref.Source = strings.ToUpper(ref.Source)
		kept = append(kept, ref)
	}
	r.References = kept

	if r.DurationS < 0 {
		r.DurationS = 0
	}
}

// DefaultSourceCodes are the scripture codes the corpus addresses recordings
// by — the same canon the corpus filename parser accepts. A reference to
// anything else is an invention, not a citation.
var DefaultSourceCodes = []string{
	"BG", "SB", "CC_ADI", "CC_MADHYA", "CC_ANTYA", "ISO", "NOD", "BS",
}

// SourceCodeSet turns a code list into the lookup Validate wants.
func SourceCodeSet(codes []string) map[string]bool {
	set := make(map[string]bool, len(codes))
	for _, c := range codes {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			set[c] = true
		}
	}
	return set
}
