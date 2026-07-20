// Package hybridreview is a chain-based review provider:
//
//   - The first reviewer in the chain runs on every chunk — text
//     passthrough, capitalization fixes, light corrections.
//   - The remaining reviewers form a per-island fallback chain. For
//     each "island" of low-confidence segments inside a chunk, the
//     reviewers are tried in order: on transport error or audit-gate
//     failure the next reviewer gets a turn at the SAME island. This
//     contains expensive premium re-runs to a few segments rather
//     than the whole chunk.
//
// All reviewer outputs are merged at the segment level: an accepted
// premium response overrides baseline text and sentence boundaries
// inside the original island; the rest of the chunk uses baseline.
//
// Hybrid is constructed at runtime by the review usecase when the
// caller passes a 2+-element model list (`models="A,B[,C,...]"`); it
// is NOT a separately registered provider.
package hybridreview

import (
	"context"
	"fmt"
	"sort"

	"github.com/jiva-studio/shruti/pipeline/ports/review"
)

// Reviewer composes a chain into a hybrid pass. Reviewers[0] runs on
// every chunk as the baseline; Reviewers[1:] are the per-island
// fallback chain — tried in order on each low-confidence island,
// audit-gate'd, escalating to the next on failure. A 1-element chain
// degenerates to a baseline-only pass (premium phase skipped).
//
// We keep a single slice rather than separate cheap/premium fields so
// the chain concept stays uniform with the per-chunk attempt chain at
// the use case level — the same vocabulary throughout.
type Reviewer struct {
	Reviewers       []review.Reviewer
	Threshold       float64
	Expand          int
	PremiumMinChars int
}

// New constructs a hybrid from one or more reviewers. reviewers[0] is
// the baseline; reviewers[1:] are the per-island premium fallback chain.
// A nil/empty slice or a single-entry slice is allowed (premium phase
// skipped).
func New(reviewers []review.Reviewer, threshold float64, expand, premiumMinChars int) *Reviewer {
	if threshold == 0 {
		threshold = 0.70
	}
	if expand < 0 {
		expand = 0
	}
	return &Reviewer{
		Reviewers:       append([]review.Reviewer{}, reviewers...),
		Threshold:       threshold,
		Expand:          expand,
		PremiumMinChars: premiumMinChars,
	}
}

func (r *Reviewer) baseline() review.Reviewer {
	if len(r.Reviewers) == 0 {
		return nil
	}
	return r.Reviewers[0]
}

func (r *Reviewer) premiumChain() []review.Reviewer {
	if len(r.Reviewers) <= 1 {
		return nil
	}
	return r.Reviewers[1:]
}

func (r *Reviewer) Name() string {
	if r.baseline() == nil {
		return "hybrid"
	}
	if len(r.premiumChain()) == 0 {
		return r.baseline().Name()
	}
	out := r.baseline().Name()
	for _, p := range r.premiumChain() {
		out += "+" + p.Name()
	}
	return out
}

type interval struct{ lo, hi int } // both inclusive, indices INTO req.Segments slice (positional)

func (r *Reviewer) ReviewChunk(ctx context.Context, req review.ChunkRequest) (review.ChunkResponse, error) {
	if r.baseline() == nil {
		return review.ChunkResponse{}, fmt.Errorf("hybrid: cheap reviewer not configured")
	}

	cheapResp, err := r.baseline().ReviewChunk(ctx, req)
	if err != nil {
		return review.ChunkResponse{}, fmt.Errorf("hybrid: cheap inner failed: %w", err)
	}

	low := []int{}
	for i, s := range req.Segments {
		if s.Confidence < r.Threshold {
			low = append(low, i)
		}
	}

	if len(low) == 0 || len(r.premiumChain()) == 0 {
		// Baseline-only path. Re-tag the inner's models with role:"baseline"
		// so consumers see a consistent two-tier shape even when the
		// premium pass didn't run.
		out := cheapResp
		out.Models = retagRole(cheapResp.Models, "baseline")
		return out, nil
	}

	rawIslands := groupRuns(low)
	expanded := expandAndMerge(rawIslands, r.Expand, len(req.Segments))

	originalIdxSet := make(map[int]struct{}, len(low))
	lowPosSet := make(map[int]struct{}, len(low))
	for _, pos := range low {
		originalIdxSet[req.Segments[pos].Idx] = struct{}{}
		lowPosSet[pos] = struct{}{}
	}

	type premiumCall struct {
		island     interval
		islandIdxs map[int]struct{}
		response   review.ChunkResponse
	}
	premiumCalls := make([]premiumCall, 0, len(expanded))
	premiumModels := []review.ModelEntry{}

	for _, isl := range expanded {
		// Skip premium when the island's original low-confidence segments
		// carry too little text — pro can't meaningfully reconstruct
		// "..." or "Да." and we'd burn $0.02-0.03 per call. The threshold
		// applies to summed character count of the ORIGINAL low-conf
		// triggers; the surrounding expansion context isn't counted.
		if r.PremiumMinChars > 0 {
			lowChars := 0
			for p := isl.lo; p <= isl.hi; p++ {
				if _, ok := lowPosSet[p]; ok {
					lowChars += len(req.Segments[p].Text)
				}
			}
			if lowChars < r.PremiumMinChars {
				premiumModels = append(premiumModels, review.ModelEntry{
					Role:    "premium",
					Outcome: review.OutcomeIslandSkipped,
					Note:    fmt.Sprintf("low-conf chars %d < min %d", lowChars, r.PremiumMinChars),
					Name:    r.premiumChain()[0].Name(),
				})
				continue
			}
		}

		segs := append([]review.ChunkSegment{}, req.Segments[isl.lo:isl.hi+1]...)
		var prev []review.ChunkSegment
		if isl.lo > 0 {
			tailFrom := isl.lo - r.Expand*2
			if tailFrom < 0 {
				tailFrom = 0
			}
			prev = append([]review.ChunkSegment{}, req.Segments[tailFrom:isl.lo]...)
		} else if len(req.PrevTail) > 0 {
			prev = req.PrevTail
		}
		subReq := review.ChunkRequest{
			Language:    req.Language,
			Segments:    segs,
			PrevTail:    prev,
			SystemHint:  req.SystemHint,
			ExtraPrompt: req.ExtraPrompt,
		}

		// Per-island premium chain: try each premium provider in order;
		// on transport error or audit-gate failure, escalate to the next.
		// All exhausted → cheap stays for this island.
		var accepted *premiumCall
		for _, premium := range r.premiumChain() {
			presp, err := premium.ReviewChunk(ctx, subReq)
			if err != nil {
				// Transport failure: record as rejection and try the
				// next premium for this island. Don't propagate an error
				// because cheap baseline already covers the segments.
				premiumModels = append(premiumModels, review.ModelEntry{
					Role:    "premium",
					Outcome: review.OutcomeIslandTransport,
					Name:    premium.Name(),
					Note:    err.Error(),
				})
				continue
			}

			// Per-island audit gate: model returned structurally valid
			// idx-set but the content is shifted / has empty tails.
			islandFlags := review.DetectAuditFlags(subReq, presp)
			if review.AnyCriticalAuditFlag(islandFlags) {
				for _, m := range presp.Models {
					m.Role = "premium"
					m.Outcome = review.OutcomeIslandRejected
					m.AuditFlags = islandFlags
					premiumModels = append(premiumModels, m)
				}
				continue
			}

			idxSet := make(map[int]struct{}, len(segs))
			for _, s := range segs {
				idxSet[s.Idx] = struct{}{}
			}
			accepted = &premiumCall{island: isl, islandIdxs: idxSet, response: presp}
			for _, m := range presp.Models {
				m.Role = "premium"
				premiumModels = append(premiumModels, m)
			}
			break
		}

		if accepted != nil {
			premiumCalls = append(premiumCalls, *accepted)
		}
	}

	textMap := make(map[int]string, len(req.Segments))
	for _, s := range cheapResp.Segments {
		textMap[s.Idx] = s.Text
	}
	for _, pc := range premiumCalls {
		for _, ps := range pc.response.Segments {
			if _, isOrig := originalIdxSet[ps.Idx]; isOrig {
				textMap[ps.Idx] = ps.Text
			}
		}
	}

	closesMap := make(map[int]bool, len(req.Segments))
	for _, group := range cheapResp.Sentences {
		if len(group) == 0 {
			continue
		}
		closesMap[group[len(group)-1]] = true
	}
	for _, pc := range premiumCalls {
		for idx := range pc.islandIdxs {
			delete(closesMap, idx)
		}
		for _, group := range pc.response.Sentences {
			if len(group) == 0 {
				continue
			}
			last := group[len(group)-1]
			if _, in := pc.islandIdxs[last]; in {
				closesMap[last] = true
			}
		}
	}

	outSegs := make([]review.ChunkSegment, len(req.Segments))
	for i, s := range req.Segments {
		outSegs[i] = review.ChunkSegment{Idx: s.Idx, Text: textMap[s.Idx]}
	}
	sentences := [][]int{}
	cur := []int{}
	for i, s := range req.Segments {
		cur = append(cur, s.Idx)
		isLast := i == len(req.Segments)-1
		if closesMap[s.Idx] || isLast {
			sentences = append(sentences, cur)
			cur = nil
		}
	}

	models := append([]review.ModelEntry{}, retagRole(cheapResp.Models, "baseline")...)
	models = append(models, premiumModels...)

	return review.ChunkResponse{
		Segments:  outSegs,
		Sentences: sentences,
		Models:    models,
	}, nil
}

func retagRole(in []review.ModelEntry, role string) []review.ModelEntry {
	if len(in) == 0 {
		return nil
	}
	out := make([]review.ModelEntry, len(in))
	for i, m := range in {
		m.Role = role
		out[i] = m
	}
	return out
}

func groupRuns(positions []int) []interval {
	if len(positions) == 0 {
		return nil
	}
	sort.Ints(positions)
	out := []interval{{lo: positions[0], hi: positions[0]}}
	for _, p := range positions[1:] {
		last := &out[len(out)-1]
		if p == last.hi+1 {
			last.hi = p
		} else {
			out = append(out, interval{lo: p, hi: p})
		}
	}
	return out
}

func expandAndMerge(islands []interval, expand, total int) []interval {
	if len(islands) == 0 {
		return nil
	}
	expanded := make([]interval, 0, len(islands))
	for _, isl := range islands {
		lo := isl.lo - expand
		if lo < 0 {
			lo = 0
		}
		hi := isl.hi + expand
		if hi >= total {
			hi = total - 1
		}
		expanded = append(expanded, interval{lo: lo, hi: hi})
	}
	merged := []interval{expanded[0]}
	for _, isl := range expanded[1:] {
		last := &merged[len(merged)-1]
		if isl.lo <= last.hi+1 {
			if isl.hi > last.hi {
				last.hi = isl.hi
			}
		} else {
			merged = append(merged, isl)
		}
	}
	return merged
}

var _ review.Reviewer = (*Reviewer)(nil)
