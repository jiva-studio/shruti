package topics

import (
	"sort"

	outlineport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/outline"
)

const (
	// defaultTopK caps how many topics a track carries.
	defaultTopK = 8
	// defaultFloor drops topics that barely register before renormalizing.
	defaultFloor = 0.03
)

// langWeights computes one language's topic distribution for a track: each
// heading is matched to its nearest topic centroid (skipped when the best
// cosine similarity is below minSim), and contributes duration×similarity to
// that topic. The result is normalized to sum 1 (empty when nothing assigns).
//
// entries[i] is paired with vecs[i] (the embedding of entries[i].Title).
// centroids[j] is the centroid for topicIDs[j].
func langWeights(entries []outlineport.GranularEntry, vecs, centroids [][]float32, topicIDs []string, minSim float64) map[string]float64 {
	raw := map[string]float64{}
	var total float64
	for i, e := range entries {
		if i >= len(vecs) {
			break
		}
		c, sim := nearest(vecs[i], centroids)
		if c < 0 || sim < minSim {
			continue
		}
		dur := float64(e.End - e.Start)
		if dur <= 0 {
			continue
		}
		conf := sim
		if conf < 0 {
			conf = 0
		}
		contrib := dur * conf
		raw[topicIDs[c]] += contrib
		total += contrib
	}
	if total == 0 {
		return map[string]float64{}
	}
	for t := range raw {
		raw[t] /= total
	}
	return raw
}

// mergeMax unions two per-language distributions by taking the larger weight
// for each topic — the same lecture in ru and en should reinforce, not dilute.
func mergeMax(into, other map[string]float64) {
	for t, w := range other {
		if w > into[t] {
			into[t] = w
		}
	}
}

// topKFloorRenorm keeps the highest-weight topics (at most k), drops anything
// below floor, and renormalizes the survivors to sum 1.
func topKFloorRenorm(weights map[string]float64, k int, floor float64) map[string]float64 {
	type tw struct {
		id string
		w  float64
	}
	list := make([]tw, 0, len(weights))
	for id, w := range weights {
		if w >= floor {
			list = append(list, tw{id, w})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].w != list[j].w {
			return list[i].w > list[j].w
		}
		return list[i].id < list[j].id // stable tiebreak
	})
	if len(list) > k {
		list = list[:k]
	}
	var total float64
	for _, e := range list {
		total += e.w
	}
	out := make(map[string]float64, len(list))
	if total == 0 {
		return out
	}
	for _, e := range list {
		out[e.id] = e.w / total
	}
	return out
}
