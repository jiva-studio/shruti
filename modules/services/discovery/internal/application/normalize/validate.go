package normalize

import (
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
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

// DefaultSourceCodes and SourceCodeSet moved to domain, where the canon
// belongs: it is knowledge about the corpus rather than about reading a page,
// and reading a question needs the same list.
var DefaultSourceCodes = domain.SourceCodes

// SourceCodeSet turns a code list into the lookup Validate wants.
func SourceCodeSet(codes []string) map[string]bool { return domain.SourceCodeSet(codes) }
