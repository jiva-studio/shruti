package runingest

import (
	"encoding/json"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
)

// statusData is the track.queued / track.processing event payload (the
// server-owned library_items projection applied verbatim by the profile
// consumer). title_raw is carried so the pre-ready card has a title — the
// projection is a replace-all upsert, so every state must ship the fields it
// wants visible. Shape is part of the downstream contract — keep it stable.
func statusData(status, title string) []byte {
	b, _ := json.Marshal(map[string]any{"status": status, "title_raw": title})
	return b
}

// failData is the track.failed event payload. Carries title_raw (same replace-all
// reason as statusData) so the failed card still shows the lecture's title.
func failData(msg, title string) []byte {
	b, _ := json.Marshal(map[string]any{"status": "failed", "error": msg, "title_raw": title})
	return b
}

// readyResult is the track.ready event payload (and the job's terminal Result),
// projected from the worker's ready result. Shape is part of the downstream
// contract — keep it stable.
func readyResult(res ingest.Result) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":         "ready",
		"track_id":       res.TrackID,
		"lang":           res.Lang,
		"title_raw":      res.Title,
		"audio_key":      res.AudioKey,
		"transcript_key": res.TranscriptKey,
		"source_url":     res.SourceURL,
	})
	return b
}
