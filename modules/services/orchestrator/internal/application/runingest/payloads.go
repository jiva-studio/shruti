package runingest

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
)

// progressData is the jobs.progress blob for a pipeline-stage heartbeat — the
// poll-only granular status the ingest API serves (not a track.events payload,
// never projected into library_items). Minimal + stable shape. percent is
// carried only when meaningful (>0, the downloading stage), so a stage with no
// measure doesn't advertise a bogus 0%.
func progressData(stage string, percent int) []byte {
	m := map[string]any{"stage": stage}
	if percent > 0 {
		m["percent"] = percent
	}
	b, _ := json.Marshal(m)
	return b
}

// statusData is the track.queued / track.processing event payload (the
// server-owned library_items projection applied verbatim by the profile
// consumer). title_raw is carried so the pre-ready card has a title, and
// source_url so the client can match the row to its origin URL BEFORE the ready
// projection (the chat card / add flow key on it) — the projection is a
// replace-all upsert, so every state must ship the fields it wants visible.
// Shape is part of the downstream contract — keep it stable.
func statusData(status, title, sourceURL string) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":     status,
		"title_raw":  title,
		"source_url": sourceURL,
	})
	return b
}

// failData is the track.failed event payload. Carries title_raw (same replace-all
// reason as statusData) so the failed card still shows the lecture's title.
//
// The `error` field is a STABLE machine code, not the raw internal error. This
// payload is projected into library_items and synced down to the user's device,
// so putting `transcribe: deepgram: 503` in it would leak our internals and our
// vendors into a user-visible row, and would hand the client an unlocalizable
// string it can only render verbatim. A code the client can switch on and
// translate is both safer and more useful. The raw text is not lost — it stays
// in orchestrator.jobs.error and in the logs, which is where debugging belongs.
// The key is `error` to match the library_items `error` column the whole
// downstream chain (profile projection, sync wire, client row) already maps.
func failData(msg, title, sourceURL string) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":     "failed",
		"error":      failCode(msg),
		"title_raw":  title,
		"source_url": sourceURL,
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
// mergeReady computes a track membership's new (version, doc) for a ready result.
// Ingest sets the full doc at the run's generation; translate appends its single
// variant to the existing doc and takes version+1 so its ready out-ranks the
// prior state under the profile's (version, rank) LWW.
func mergeReady(j *job.Job, res ingest.Result, m *job.Membership) (int, []byte, error) {
	if j.Op == job.OpTranslate {
		if m == nil {
			return 0, nil, fmt.Errorf("translate ready for unknown membership %s", j.MembershipID)
		}
		doc, err := mergeVariants(m.Doc, res.Variants)
		if err != nil {
			return 0, nil, err
		}
		return m.Version + 1, doc, nil
	}
	version := j.Generation
	if m != nil && m.Version > version {
		version = m.Version
	}
	return version, readyResult(res), nil
}

// mergeVariants inserts/replaces (by language) the given variants into the
// "variants" array of an existing library_items doc, returning the merged doc —
// so a translated variant is added without reconstructing the rest, and a
// re-translation of the same language replaces the old one.
func mergeVariants(doc []byte, add []ingest.Variant) ([]byte, error) {
	fields := map[string]json.RawMessage{}
	if len(doc) > 0 {
		if err := json.Unmarshal(doc, &fields); err != nil {
			return nil, fmt.Errorf("merge variants: parse doc: %w", err)
		}
	}
	var variants []ingest.Variant
	if raw, ok := fields["variants"]; ok && len(raw) > 0 {
		_ = json.Unmarshal(raw, &variants)
	}
	byLang := map[string]int{}
	for i, v := range variants {
		byLang[v.Lang] = i
	}
	for _, v := range add {
		if i, ok := byLang[v.Lang]; ok {
			variants[i] = v
		} else {
			byLang[v.Lang] = len(variants)
			variants = append(variants, v)
		}
	}
	b, err := json.Marshal(variants)
	if err != nil {
		return nil, err
	}
	fields["variants"] = b
	return json.Marshal(fields)
}

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
		"kind_tag":       res.KindTag,
		"references":     res.References,
		"cover_key":      res.CoverKey,
		"duration":       res.Duration,
		"audio_key":      res.AudioKey,
		"transcript_key": res.TranscriptKey,
		"variants":       res.Variants,
		"source_url":     res.SourceURL,
	})
	return b
}
