// Package reviewreg registers the available transcript review backends.
package reviewreg

import (
	"fmt"
	"sync"

	"github.com/jiva-studio/lectorium/pipeline/ports/review"
	hybridreview "github.com/jiva-studio/lectorium/pipeline/review/hybrid"
)

// Registry implements review.Registry.
//
// HybridThreshold / HybridExpand / HybridPremiumMinChars are the policy
// knobs applied when a 2-element model list is composed via Compose;
// setting them at construction time (main.go wiring) keeps the
// application layer free of hybrid-specific tuning.
type Registry struct {
	mu                    sync.RWMutex
	items                 map[string]review.Reviewer
	HybridThreshold       float64
	HybridExpand          int
	HybridPremiumMinChars int
}

func New(hybridThreshold float64, hybridExpand, hybridPremiumMinChars int) *Registry {
	return &Registry{
		items:                 map[string]review.Reviewer{},
		HybridThreshold:       hybridThreshold,
		HybridExpand:          hybridExpand,
		HybridPremiumMinChars: hybridPremiumMinChars,
	}
}

func (r *Registry) Register(rv review.Reviewer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[rv.Name()] = rv
}

func (r *Registry) Get(name string) (review.Reviewer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rv, ok := r.items[name]
	return rv, ok
}

func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.items))
	for n := range r.items {
		out = append(out, n)
	}
	return out
}

func (r *Registry) Compose(models []string, overrides *review.HybridOverrides) (review.Reviewer, error) {
	if len(models) == 0 {
		return nil, fmt.Errorf("review: at least one model alias required")
	}
	if len(models) == 1 {
		rv, ok := r.Get(models[0])
		if !ok {
			return nil, fmt.Errorf("review: provider %q not registered (available: %v)", models[0], r.List())
		}
		return rv, nil
	}
	// 2+ models: hybrid pass. models[0] = baseline, models[1:] = per-island premium chain.
	chain := make([]review.Reviewer, len(models))
	for i, name := range models {
		rv, ok := r.Get(name)
		if !ok {
			return nil, fmt.Errorf("review: provider %q not registered (available: %v)", name, r.List())
		}
		chain[i] = rv
	}
	threshold := r.HybridThreshold
	expand := r.HybridExpand
	premiumMinChars := r.HybridPremiumMinChars
	if overrides != nil {
		if overrides.Threshold != nil {
			threshold = *overrides.Threshold
		}
		if overrides.Expand != nil {
			expand = *overrides.Expand
		}
		if overrides.PremiumMinChars != nil {
			premiumMinChars = *overrides.PremiumMinChars
		}
	}
	return hybridreview.New(chain, threshold, expand, premiumMinChars), nil
}

var _ review.Registry = (*Registry)(nil)
