// Package topics holds the recommender's offline vocabulary types — the topic
// centroids used to assign a track's outline headings to canonical topics.
// These never reach the client catalog; they live in a private artifact.
package topics

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

// Vocabulary is the persisted set of topic centroids the assign step matches a
// track's headings against. Stored as artifacts/topics/centroids.json (private,
// rides S3), never in current.db — the client never needs vectors.
type Vocabulary struct {
	Dim         int        `json:"dim"`
	EmbedModel  string     `json:"embed_model"`
	MaxDistance float64    `json:"max_distance"` // cosine-distance cutoff; a heading beyond this matches no topic
	Centroids   []Centroid `json:"centroids"`
}
