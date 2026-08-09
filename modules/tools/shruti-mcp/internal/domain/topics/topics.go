// Package topics holds the recommender's offline vocabulary types — the topic
// centroids used to assign a track's outline headings to canonical topics.
// These never reach the client catalog; they live in a private artifact.
package topics

import "time"

// Names is one cluster's canonical name across locales: a full name (always
// present for every requested language) and an optional shorter display name
// for tight surfaces. Both are language → text maps — no locale is special.
type Names struct {
	Full  map[string]string
	Short map[string]string
}

// Centroid is one canonical topic's cluster center in embedding space, keyed by
// the topic's catalog id (topic_<nanoid>). The vector matches the configured
// embedding model/dim.
type Centroid struct {
	TopicID string    `json:"topic_id"`
	Vector  []float32 `json:"vector"`
}

// HeadingVectors is every distinct outline heading with its embedding, kept
// between builds. Embedding is what a build spends its time on; clustering the
// result is minutes. Holding the vectors makes trying a different k cheap
// enough to choose k by measurement instead of by assumption.
//
// Titles[i] pairs with Vectors[i]. Model is recorded because vectors from two
// models cannot be mixed — a changed model invalidates the whole cache.
type HeadingVectors struct {
	Model   string
	Dim     int
	Titles  []string
	Vectors [][]float32
}

// Vocabulary is the persisted set of topic centroids the assign step matches a
// track's headings against. Stored as artifacts/topics/centroids.json (private,
// rides S3), never in current.db — the client never needs vectors.
type Vocabulary struct {
	Dim         int        `json:"dim"`
	EmbedModel  string     `json:"embed_model"`
	MaxDistance float64    `json:"max_distance"` // cosine-distance cutoff; a heading beyond this matches no topic
	BuiltAt     time.Time  `json:"built_at,omitempty"`
	Centroids   []Centroid `json:"centroids"`
}
