package topics

import "math"

// normalize returns a unit-length copy of v (L2). A zero vector is returned
// as-is. On normalized vectors, cosine similarity is just the dot product.
func normalize(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	if sum == 0 {
		out := make([]float32, len(v))
		copy(out, v)
		return out
	}
	inv := float32(1.0 / math.Sqrt(sum))
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = x * inv
	}
	return out
}

// dot is the cosine similarity of two already-normalized vectors.
func dot(a, b []float32) float64 {
	var s float64
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		s += float64(a[i]) * float64(b[i])
	}
	return s
}

// nearest returns the index of the centroid most similar to v (max cosine on
// normalized vectors) and that similarity. centroids must be normalized.
// Returns (-1, 0) when there are no centroids.
func nearest(v []float32, centroids [][]float32) (int, float64) {
	best, bestSim := -1, math.Inf(-1)
	for i, c := range centroids {
		if s := dot(v, c); s > bestSim {
			best, bestSim = i, s
		}
	}
	if best < 0 {
		return -1, 0
	}
	return best, bestSim
}
