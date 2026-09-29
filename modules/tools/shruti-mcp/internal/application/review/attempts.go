package review

import (
	"fmt"

	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
)

// composeAttempts resolves the chain of reviewers a chunk falls through on
// audit failure. Models given in the call are one ad-hoc attempt without
// overrides; otherwise the configured chain for the language applies. Every
// attempt is composed up front, so a typo in the config fails the run at its
// start rather than when the first chunk reaches the broken fallback.
//
// models is the first attempt's alias list, which the result and review.json
// record; each chunk artifact records the attempt that actually served it.
func (uc UseCase) composeAttempts(language string, opts Options) (reviewers []reviewport.Reviewer, models []string, err error) {
	var attempts []Attempt
	if len(opts.Models) > 0 {
		attempts = []Attempt{{Models: opts.Models}}
	} else if uc.DefaultAttemptsFor != nil {
		attempts = uc.DefaultAttemptsFor(language)
	}
	if len(attempts) == 0 {
		return nil, nil, fmt.Errorf("review: no models specified and no default configured for language %q", language)
	}
	reviewers = make([]reviewport.Reviewer, len(attempts))
	for i, a := range attempts {
		r, err := uc.Reviewers.Compose(a.Models, &reviewport.HybridOverrides{
			Threshold:       a.Threshold,
			Expand:          a.Expand,
			PremiumMinChars: a.PremiumMinChars,
		})
		if err != nil {
			return nil, nil, fmt.Errorf("review: attempt %d (%v): %w", i, a.Models, err)
		}
		reviewers[i] = r
	}
	return reviewers, attempts[0].Models, nil
}
