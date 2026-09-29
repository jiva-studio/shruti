package config

// Topics configures the offline topic recommender: how the vocabulary is
// clustered (topics.build) and how many topics a track ends up carrying
// (track.topics.assign). Every field has a default, so an absent section keeps
// the defaults below.
//
// TopK is the one worth revisiting per corpus: with granular outlines a low
// cap, rather than the similarity, decides which topics a track keeps.
type Topics struct {
	K           int     `yaml:"k,omitempty"`            // clusters to build
	Iters       int     `yaml:"iters,omitempty"`        // k-means iterations
	Seed        int64   `yaml:"seed,omitempty"`         // clustering seed
	MaxDistance float64 `yaml:"max_distance,omitempty"` // cosine-distance cutoff for a heading
	Samples     int     `yaml:"samples,omitempty"`      // headings shown to the namer
	TopK        int     `yaml:"top_k,omitempty"`        // topics kept per track
	Floor       float64 `yaml:"floor,omitempty"`        // weight below which a topic is dropped
}

func (t *Topics) applyDefaults() {
	if t.K == 0 {
		t.K = 150
	}
	if t.Iters == 0 {
		t.Iters = 25
	}
	if t.Seed == 0 {
		t.Seed = 42
	}
	if t.MaxDistance == 0 {
		t.MaxDistance = 0.45
	}
	if t.Samples == 0 {
		t.Samples = 12
	}
	if t.TopK == 0 {
		t.TopK = 8
	}
	if t.Floor == 0 {
		t.Floor = 0.03
	}
}
