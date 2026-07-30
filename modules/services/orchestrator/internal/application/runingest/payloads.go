package runingest

import (
	"encoding/json"
	"strings"

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
//
// It ships a STABLE machine code, not the raw internal error. This payload is
// projected into library_items and synced down to the user's device, so putting
// `transcribe: deepgram: 503` in it would leak our internals and our vendors
// into a user-visible row, and would hand the client an unlocalizable string it
// can only render verbatim. A code the client can switch on and translate is
// both safer and more useful. The raw text is not lost — it stays in
// orchestrator.jobs.error and in the logs, which is where debugging belongs.
func failData(msg, title string) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":     "failed",
		"error_code": failCode(msg),
		"title_raw":  title,
	})
	return b
}

// Stable failure codes for the client. Part of the downstream contract — add to
// this set rather than renaming, and let unknown codes fall back to `internal`.
const (
	codeUnauthorized = "unauthorized" // PRO tier not verified
	codeUnavailable  = "unavailable"  // source gone/private/blocked
	codeUnsupported  = "unsupported"  // not a URL we can fetch
	codeTooLarge     = "too_large"    // exceeds size/duration limits
	codeNoSpeech     = "no_speech"    // transcription produced nothing usable
	codeInternal     = "internal"     // anything else — our fault
)

// failCode maps an internal error string onto a client-facing code. Matching on
// the message is admittedly brittle, but the alternative — threading a typed
// error across the broker boundary — would put the classification in the
// worker's wire contract, where a future stage would have to remember to
// populate it. Keeping it here means one place to audit, and an unmatched
// message degrades to `internal` rather than leaking.
func failCode(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "pro tier not verified"):
		return codeUnauthorized
	case strings.Contains(m, "unsupported url"), strings.Contains(m, "not a valid url"):
		return codeUnsupported
	case strings.Contains(m, "too large"), strings.Contains(m, "too long"),
		strings.Contains(m, "max-filesize"), strings.Contains(m, "exceeds"):
		return codeTooLarge
	case strings.Contains(m, "produced no blocks"):
		return codeNoSpeech
	// These must stay NARROW. A bare "unavailable" also matches HTTP 503
	// "Service Unavailable" — our own dependency failing — which would tell the
	// user their lecture is gone when the truth is that we broke. The fetch
	// adapter's "(permanent)" wrapper is the reliable signal; the rest are the
	// specific phrases yt-dlp emits for a genuinely dead source.
	case strings.Contains(m, "(permanent)"),
		strings.Contains(m, "video unavailable"),
		strings.Contains(m, "no longer available"),
		strings.Contains(m, "private video"),
		strings.Contains(m, "has been removed"),
		strings.Contains(m, "age-restricted"),
		strings.Contains(m, "members-only"):
		return codeUnavailable
	default:
		return codeInternal
	}
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
		"author_raw":     res.AuthorRaw,
		"location_raw":   res.LocationRaw,
		"date_raw":       res.Date,
		"date":           res.Date,
		"references":     res.References,
		"description":    res.Description,
		"outline":        res.Outline,
		"cover_key":      res.CoverKey,
		"audio_key":      res.AudioKey,
		"transcript_key": res.TranscriptKey,
		"source_url":     res.SourceURL,
	})
	return b
}
