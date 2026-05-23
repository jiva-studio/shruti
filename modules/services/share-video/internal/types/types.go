// Package types holds the JSON shapes that cross the queue (public.tasks
// payload) and the HTTP boundary. Field tags MUST stay camelCase because
// the legacy Node service stored rows with this exact shape, and a
// version mismatch breaks lookup-by-payload-key in SQL.
package types

// RenderRequest is what POST /reels accepts (snake_case in flight) and
// what the worker reads from the task payload (camelCase at rest — see
// `Marshal` for the at-rest shape).
type RenderRequest struct {
	SourceKey string `json:"sourceKey"`
	StartMs   int64  `json:"startMs"`
	EndMs     int64  `json:"endMs"`
	Text      string `json:"text"`
	Lang      string `json:"lang"`
	Theme     string `json:"theme"`
	VideoID   string `json:"videoId,omitempty"`
	Title     string `json:"title,omitempty"`
}

// TaskPayload is the value stored in public.tasks.payload (jsonb).
// `user_id` is snake_case because Express stored it that way and we
// SQL-query payload->>'user_id' in the HTTP layer.
type TaskPayload struct {
	Request RenderRequest `json:"request"`
	UserID  string        `json:"user_id"`
}

// TaskResult is the value stored in public.tasks.result when the worker
// finishes successfully.
type TaskResult struct {
	URL       string `json:"url"`
	OutputKey string `json:"output_key"`
}

// Slide is the unit of caller text after force-alignment. A slide spans
// one screen-full of text (≤60 chars) with per-word timings inside.
type Slide struct {
	Text      string        `json:"text"`
	StartTime float64       `json:"startTime"` // seconds from reel start
	Duration  float64       `json:"duration"`
	Words     []WordTiming  `json:"words,omitempty"`
}

// WordTiming pairs the caller's surface form with Whisper's seconds.
type WordTiming struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}
