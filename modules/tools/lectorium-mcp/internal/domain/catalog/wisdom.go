package catalog

// DailyWisdom is one playable lecture fragment tied to a topic: a short
// excerpt of `text` spanning [StartMs, EndMs] of TrackID, used by the mobile
// "daily wisdom" proactive rule.
type DailyWisdom struct {
	ID        string `json:"id"`
	TrackID   string `json:"track_id"`
	Language  string `json:"language"`
	StartMs   int64  `json:"start_ms"`
	EndMs     int64  `json:"end_ms"`
	Text      string `json:"text"`
	TopicID   string `json:"topic_id"`
	CreatedAt int64  `json:"created_at,omitempty"`
}
