package search

import "github.com/jiva-studio/shruti/discovery/internal/domain"

// rrfK damps the contribution of low-ranked hits in the fusion.
const rrfK = 60

// fuse merges the rankings by reciprocal rank. Scores from an ANN search and
// from ts_rank are not on the same scale and cannot be added; their positions
// can.
func fuse(q Query, lanes ...[]domain.Hit) []domain.Hit {
	type acc struct {
		hit   domain.Hit
		score float64
	}
	byItem := map[int64]*acc{}
	var order []int64

	for _, lane := range lanes {
		for rank, h := range lane {
			a, ok := byItem[h.ItemID]
			if !ok {
				a = &acc{hit: h}
				byItem[h.ItemID] = a
				order = append(order, h.ItemID)
			}
			a.score += 1 / float64(rrfK+rank+1)
			// Keep whichever lane's chunk ranked highest as the shown excerpt.
			if a.hit.Chunk == "" {
				a.hit.Chunk = h.Chunk
			}
			if a.hit.Summary == "" {
				a.hit.Summary = h.Summary
			}
			if a.hit.Highlight == "" {
				a.hit.Highlight = h.Highlight
			}
		}
	}

	out := make([]domain.Hit, 0, len(order))
	for _, id := range order {
		a := byItem[id]
		a.hit.Score = a.score
		out = append(out, a.hit)
	}
	// Stable ordering by fused score, highest first.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Score > out[j-1].Score; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}

	if q.Offset >= len(out) {
		return nil
	}
	out = out[q.Offset:]
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out
}
