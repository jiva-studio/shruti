// Package types holds the JSON shapes that cross the queue (public.tasks
// payload) and the HTTP boundary. Field tags MUST stay camelCase because
// the legacy Node service stored rows with this exact shape, and a
// version mismatch breaks lookup-by-payload-key in SQL.
package types

import "strings"

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
	// SkipIntro drops the cream title card at the start of the reel even
	// when Title is set. SkipLogo drops the logo.mp4 clip appended at the
	// end. Both default false, so existing callers keep the branded reel.
	SkipIntro bool `json:"skipIntro,omitempty"`
	SkipLogo  bool `json:"skipLogo,omitempty"`

	// Audio, when set, runs post-cut cleanup (loudness normalize + dead-
	// pause removal) before transcription so the resulting reel is tight.
	// Nil → legacy stream-copy, no re-encode.
	Audio *AudioOptions `json:"audio,omitempty"`
	// Layout, when set, is authoritative for the on-screen composition
	// (header / center shloka / transcript sections + intro/outro). Nil →
	// legacy single-caption reel driven by Title/SkipIntro/SkipLogo.
	Layout *Layout `json:"layout,omitempty"`
}

// AudioOptions controls post-cut audio cleanup. Both default false, so a
// request without an "audio" block behaves exactly as before.
type AudioOptions struct {
	Normalize   bool `json:"normalize,omitempty"`
	TrimSilence bool `json:"trimSilence,omitempty"`
}

// Layout is the optional, caller-supplied render composition. Sections
// are persistent for the whole clip (decided 2026-07-15): header and
// center shloka stay on screen while only the transcript animates.
type Layout struct {
	Intro    *IntroSpec `json:"intro,omitempty"`
	Outro    *OutroSpec `json:"outro,omitempty"`
	Sections *Sections  `json:"sections,omitempty"`
	Brand    *BrandSpec `json:"brand,omitempty"`
}

// BrandSpec is the persistent watermark drawn on every frame — the real
// brand-recall lever (an end card reaches ~10% of viewers, a watermark
// reaches ~100%). Position is "under_header" or "corner".
type BrandSpec struct {
	Enabled  bool   `json:"enabled"`
	Text     string `json:"text,omitempty"`
	Position string `json:"position,omitempty"`
}

// IntroSpec configures the leading title card (the "first frame"). Icon
// toggles the branded icon on the card; Title is the card text.
type IntroSpec struct {
	Enabled bool   `json:"enabled"`
	Title   string `json:"title,omitempty"`
	Icon    bool   `json:"icon,omitempty"`
}

// OutroSpec configures the trailing logo clip (the "last frame").
type OutroSpec struct {
	Enabled bool `json:"enabled"`
}

// Sections groups the three persistent overlay zones.
type Sections struct {
	Header     *HeaderSection     `json:"header,omitempty"`
	Center     *CenterSection     `json:"center,omitempty"`
	Transcript *TranscriptSection `json:"transcript,omitempty"`
}

// HeaderSection is the top hook band: a headline (Text) with an optional
// second line (Sub, e.g. a reference like "BG 2.14").
type HeaderSection struct {
	Enabled bool   `json:"enabled"`
	Text    string `json:"text,omitempty"`
	Sub     string `json:"sub,omitempty"`
}

// CenterSection is the vertical-middle zone, currently a shloka card.
type CenterSection struct {
	Enabled bool    `json:"enabled"`
	Shloka  *Shloka `json:"shloka,omitempty"`
}

// Shloka is caller-supplied verse text (decided 2026-07-15: no corpus
// resolution in this service). IAST is the transliteration line(s),
// Translation the rendered meaning.
type Shloka struct {
	IAST        string `json:"iast,omitempty"`
	Translation string `json:"translation,omitempty"`
}

// TranscriptSection toggles the animated per-word caption at the bottom
// (the legacy reel body). Disabled → the reel carries only the static
// header/center overlay over the audio.
type TranscriptSection struct {
	Enabled bool `json:"enabled"`
}

// ResolvedLayout is the effective composition after applying legacy-field
// fallback and per-field defaults. The renderer works off this, never off
// the raw pointers, so both the legacy path (Layout == nil) and the new
// path collapse to one shape.
type ResolvedLayout struct {
	IntroEnabled bool
	IntroTitle   string
	IntroIcon    bool
	OutroEnabled bool
	Header       *HeaderSection
	Center       *CenterSection
	Brand        *BrandSpec
	Transcript   bool
}

// ResolveLayout folds Layout (if any) and the legacy Title/SkipIntro/
// SkipLogo fields into a single ResolvedLayout. When Layout is nil this
// reproduces the historical single-caption reel exactly.
func (r RenderRequest) ResolveLayout() ResolvedLayout {
	if r.Layout == nil {
		return ResolvedLayout{
			IntroEnabled: !r.SkipIntro && strings.TrimSpace(r.Title) != "",
			IntroTitle:   r.Title,
			IntroIcon:    true,
			OutroEnabled: !r.SkipLogo,
			Transcript:   true,
		}
	}
	out := ResolvedLayout{Transcript: true} // transcript on unless explicitly disabled
	if in := r.Layout.Intro; in != nil {
		out.IntroEnabled = in.Enabled
		out.IntroTitle = in.Title
		out.IntroIcon = in.Icon
	}
	if strings.TrimSpace(out.IntroTitle) == "" {
		out.IntroTitle = r.Title // legacy fallback
	}
	if r.Layout.Outro != nil {
		out.OutroEnabled = r.Layout.Outro.Enabled
	}
	if s := r.Layout.Sections; s != nil {
		if s.Header != nil && s.Header.Enabled && strings.TrimSpace(s.Header.Text) != "" {
			out.Header = s.Header
		}
		if s.Center != nil && s.Center.Enabled && s.Center.Shloka != nil {
			out.Center = s.Center
		}
		if s.Transcript != nil {
			out.Transcript = s.Transcript.Enabled
		}
	}
	if b := r.Layout.Brand; b != nil && b.Enabled && strings.TrimSpace(b.Text) != "" {
		out.Brand = b
	}
	return out
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
	Text      string       `json:"text"`
	StartTime float64      `json:"startTime"` // seconds from reel start
	Duration  float64      `json:"duration"`
	Words     []WordTiming `json:"words,omitempty"`
}

// WordTiming pairs the caller's surface form with Whisper's seconds.
type WordTiming struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}
