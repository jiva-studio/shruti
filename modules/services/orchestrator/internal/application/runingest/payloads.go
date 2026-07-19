package runingest

import (
	"encoding/json"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
)

// statusData is the track.queued / track.processing event payload (the
// server-owned library_items projection applied verbatim by the profile
// consumer). Shape is part of the downstream contract — keep it stable.
func statusData(status, url string) []byte {
	b, _ := json.Marshal(map[string]any{"status": status, "url": url})
	return b
}

// failData is the track.failed event payload.
func failData(msg string) []byte {
	b, _ := json.Marshal(map[string]any{"status": "failed", "error": msg})
	return b
}

// readyResult is the track.ready event payload (and the job's terminal Result),
// projected from the worker's ready/linked result. Shape is part of the
// downstream contract — keep it stable.
func readyResult(res ingest.Result) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":         "ready",
		"track_id":       res.TrackID,
		"lang":           res.Lang,
		"title":          res.Title,
		"audio_key":      res.AudioKey,
		"transcript_key": res.TranscriptKey,
		"source_url":     res.SourceURL,
	})
	return b
}
