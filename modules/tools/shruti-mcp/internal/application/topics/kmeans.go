package topics

import (
	"math"
	"math/rand"
)

// KMeansResult is the outcome of clustering: one centroid per cluster (unit
// vectors) and the cluster index assigned to each input point (same order as
// the input).
type KMeansResult struct {
	Centroids   [][]float32
	Assignments []int
}

// kmeansCosine clusters unit vectors into k clusters using spherical k-means
// (cosine similarity), k-means++ seeding, and Lloyd iterations. Inputs must be
// L2-normalized. The seed makes runs reproducible. k is clamped to the number
// of distinct points; empty clusters are re-seeded from the farthest point so
// the result always has min(k, n) non-empty clusters.
func kmeansCosine(points [][]float32, k, iters int, seed int64) KMeansResult {
	n := len(points)
	if n == 0 || k <= 0 {
		return KMeansResult{}
	}
	if k > n {
		k = n
	}
	rng := rand.New(rand.NewSource(seed))

	centroids := kmeansPlusPlusInit(points, k, rng)
	assign := make([]int, n)
	for i := range assign {
		assign[i] = -1
	}

	for it := 0; it < iters; it++ {
		changed := false
		for i, p := range points {
			c, _ := nearest(p, centroids)
			if c != assign[i] {
				assign[i] = c
				changed = true
			}
		}
		// Recompute centroids as the normalized mean of their members.
		sums := make([][]float64, k)
		counts := make([]int, k)
		dim := len(points[0])
		for c := range sums {
			sums[c] = make([]float64, dim)
		}
		for i, p := range points {
			c := assign[i]
			counts[c]++
			for d, x := range p {
				sums[c][d] += float64(x)
			}
		}
		for c := 0; c < k; c++ {
			if counts[c] == 0 {
				// Re-seed an empty cluster from the point farthest from its
				// own centroid, so k clusters stay populated.
				centroids[c] = farthestPoint(points, centroids, assign)
				changed = true
				continue
			}
			mean := make([]float32, dim)
			for d := range mean {
				mean[d] = float32(sums[c][d] / float64(counts[c]))
			}
			centroids[c] = normalize(mean)
		}
		if !changed && it > 0 {
			break
		}
	}
	return KMeansResult{Centroids: centroids, Assignments: assign}
}

// kmeansPlusPlusInit picks k seed centroids with probability proportional to
// squared cosine distance from the nearest already-chosen seed.
func kmeansPlusPlusInit(points [][]float32, k int, rng *rand.Rand) [][]float32 {
	n := len(points)
	centroids := make([][]float32, 0, k)
	first := rng.Intn(n)
	centroids = append(centroids, cloneVec(points[first]))

	d2 := make([]float64, n)
	for i := range d2 {
		d2[i] = math.Inf(1)
	}
	for len(centroids) < k {
		last := centroids[len(centroids)-1]
		var total float64
		for i, p := range points {
			// cosine distance in [0,2]; squared for the ++ weighting.
			dist := 1 - dot(p, last)
			if sq := dist * dist; sq < d2[i] {
				d2[i] = sq
			}
			total += d2[i]
		}
		if total == 0 {
			// All remaining points coincide with chosen seeds; pad arbitrarily.
			centroids = append(centroids, cloneVec(points[rng.Intn(n)]))
			continue
		}
		target := rng.Float64() * total
		var acc float64
		pick := n - 1
		for i := range points {
			acc += d2[i]
			if acc >= target {
				pick = i
				break
			}
		}
		centroids = append(centroids, cloneVec(points[pick]))
	}
	return centroids
}

func farthestPoint(points, centroids [][]float32, assign []int) []float32 {
	worst, worstSim := 0, math.Inf(1)
	for i, p := range points {
		c := assign[i]
		if c < 0 || c >= len(centroids) {
			continue
		}
		if s := dot(p, centroids[c]); s < worstSim {
			worst, worstSim = i, s
		}
	}
	return cloneVec(points[worst])
}

func cloneVec(v []float32) []float32 {
	out := make([]float32, len(v))
	copy(out, v)
	return out
}
