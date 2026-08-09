package topics

import (
	"math"
	"testing"

	outlineport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/outline"
)

// three well-separated directions in 4-d space.
func dir(i int) []float32 {
	v := make([]float32, 4)
	v[i] = 1
	return normalize(v)
}

func jitter(base []float32, d int, amt float32) []float32 {
	v := cloneVec(base)
	v[d] += amt
	return normalize(v)
}

func TestKMeansSeparatesClusters(t *testing.T) {
	// 3 tight groups around dir(0), dir(1), dir(2).
	var pts [][]float32
	var group []int
	for g := 0; g < 3; g++ {
		base := dir(g)
		for j := 0; j < 5; j++ {
			pts = append(pts, jitter(base, 3, float32(j)*0.01))
			group = append(group, g)
		}
	}
	res := kmeansCosine(pts, 3, 20, 42)
	if len(res.Centroids) != 3 {
		t.Fatalf("expected 3 centroids, got %d", len(res.Centroids))
	}
	// Every pair in the same source group must land in the same cluster.
	for i := range pts {
		for j := range pts {
			if group[i] == group[j] && res.Assignments[i] != res.Assignments[j] {
				t.Fatalf("points %d,%d (group %d) split into clusters %d,%d",
					i, j, group[i], res.Assignments[i], res.Assignments[j])
			}
			if group[i] != group[j] && res.Assignments[i] == res.Assignments[j] {
				t.Fatalf("points %d,%d (groups %d,%d) merged into cluster %d",
					i, j, group[i], group[j], res.Assignments[i])
			}
		}
	}
}

// TestKMeansReseedsDistinctCentroids drives k above the number of natural
// groups so several clusters start empty and must be re-seeded. The bug was
// that simultaneous empty clusters all grabbed the *same* farthest point,
// collapsing into duplicate centroids; assert every centroid is distinct.
func TestKMeansReseedsDistinctCentroids(t *testing.T) {
	// Two tight groups but k=5 → at least three clusters reseed.
	var pts [][]float32
	for g := 0; g < 2; g++ {
		base := dir(g)
		for j := 0; j < 6; j++ {
			pts = append(pts, jitter(base, 3, float32(j)*0.01))
		}
	}
	const k = 5
	res := kmeansCosine(pts, k, 25, 7)
	if len(res.Centroids) != k {
		t.Fatalf("expected %d centroids, got %d", k, len(res.Centroids))
	}
	for i := 0; i < len(res.Centroids); i++ {
		for j := i + 1; j < len(res.Centroids); j++ {
			if dot(res.Centroids[i], res.Centroids[j]) > 0.99999 {
				t.Fatalf("centroids %d and %d are duplicates (sim %.5f)",
					i, j, dot(res.Centroids[i], res.Centroids[j]))
			}
		}
	}
}

func TestLangWeightsTimeShare(t *testing.T) {
	centroids := [][]float32{dir(0), dir(1)}
	topicIDs := []string{"topic_a", "topic_b"}
	// Two headings on topic_a (long, 30s+10s) and one on topic_b (20s).
	entries := []outlineport.GranularEntry{
		{Title: "a1", Start: 0, End: 30000},
		{Title: "b1", Start: 30000, End: 50000},
		{Title: "a2", Start: 50000, End: 60000},
	}
	vecs := [][]float32{dir(0), dir(1), dir(0)}

	got := langWeights(entries, vecs, centroids, topicIDs, 0.5)
	// topic_a: (30000+10000)*~1 = 40000; topic_b: 20000 → 2/3 vs 1/3.
	if math.Abs(got["topic_a"]-2.0/3.0) > 1e-6 || math.Abs(got["topic_b"]-1.0/3.0) > 1e-6 {
		t.Fatalf("expected ~{a:0.667, b:0.333}, got %v", got)
	}
}

func TestLangWeightsSkipsFarHeadings(t *testing.T) {
	centroids := [][]float32{dir(0)}
	topicIDs := []string{"topic_a"}
	entries := []outlineport.GranularEntry{
		{Title: "near", Start: 0, End: 10000},
		{Title: "far", Start: 10000, End: 20000},
	}
	vecs := [][]float32{dir(0), dir(2)} // second is orthogonal → sim 0 < minSim
	got := langWeights(entries, vecs, centroids, topicIDs, 0.5)
	if len(got) != 1 || math.Abs(got["topic_a"]-1.0) > 1e-9 {
		t.Fatalf("far heading should be skipped, got %v", got)
	}
}

func TestTopKFloorRenorm(t *testing.T) {
	in := map[string]float64{"a": 0.5, "b": 0.3, "c": 0.18, "d": 0.02}
	got := topKFloorRenorm(in, 2, 0.03) // d dropped by floor, c dropped by topK=2
	if len(got) != 2 {
		t.Fatalf("expected 2 survivors, got %v", got)
	}
	var sum float64
	for _, w := range got {
		sum += w
	}
	if math.Abs(sum-1.0) > 1e-9 {
		t.Fatalf("expected renormalized sum 1, got %v (%v)", sum, got)
	}
	if got["a"] <= got["b"] {
		t.Fatalf("ordering lost: %v", got)
	}
}

func TestMergeMaxUnions(t *testing.T) {
	ru := map[string]float64{"a": 0.6, "b": 0.4}
	en := map[string]float64{"a": 0.3, "c": 0.7}
	merged := map[string]float64{}
	mergeMax(merged, ru)
	mergeMax(merged, en)
	if merged["a"] != 0.6 || merged["b"] != 0.4 || merged["c"] != 0.7 {
		t.Fatalf("merge-max wrong: %v", merged)
	}
}

func TestAssignTopKFallsBackToDefault(t *testing.T) {
	if got := (AssignUseCase{}).topK(); got != defaultTopK {
		t.Fatalf("unset TopK should fall back to %d, got %d", defaultTopK, got)
	}
	if got := (AssignUseCase{}).floor(); got != defaultFloor {
		t.Fatalf("unset Floor should fall back to %v, got %v", defaultFloor, got)
	}
	if got := (AssignUseCase{TopK: 12, Floor: 0.05}).topK(); got != 12 {
		t.Fatalf("configured TopK ignored, got %d", got)
	}
	if got := (AssignUseCase{TopK: 12, Floor: 0.05}).floor(); got != 0.05 {
		t.Fatalf("configured Floor ignored, got %v", got)
	}
}
