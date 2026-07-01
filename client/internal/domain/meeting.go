package domain

import (
	"strings"
	"time"
)

// MeetingID uniquely identifies a stored meeting.
type MeetingID string

// TimeRange is a half-open span of session time in milliseconds.
type TimeRange struct {
	StartMs int64 `json:"start_ms"`
	EndMs   int64 `json:"end_ms"`
}

// Utterance is one committed, speaker-attributed segment of a meeting. It is the
// provider-agnostic unit of a transcript: any engine's finals map onto this.
type Utterance struct {
	Speaker    string     `json:"speaker"`              // label ("Я", "Спикер 2", "Алиса"); "" if unattributed
	Text       string     `json:"text"`
	Span       TimeRange  `json:"span"`
	Channel    int        `json:"channel"`              // source channel index
	Confidence float64    `json:"confidence,omitempty"` // 0 if the engine gives none
	Provider   ProviderID `json:"provider,omitempty"`
	Lang       Language   `json:"lang,omitempty"`
}

// Summary is the generated written summary of a meeting.
type Summary struct {
	Text  string `json:"text"`
	Model string `json:"model,omitempty"` // the model that produced it
}

// Meeting is the aggregate root: a recorded session with its attributed
// utterances and (optionally) a summary. Meta is an open string map so new
// attributes can be attached without a schema change.
type Meeting struct {
	ID         MeetingID         `json:"id"`
	StartedAt  time.Time         `json:"started_at"`
	EndedAt    time.Time         `json:"ended_at"`
	Provider   ProviderID        `json:"provider"`
	Languages  []Language        `json:"languages"`
	Utterances []Utterance       `json:"utterances"`
	Summary    *Summary          `json:"summary,omitempty"`
	Meta       map[string]string `json:"meta,omitempty"`
}

// NewMeeting starts an empty meeting from a capture plan.
func NewMeeting(id MeetingID, startedAt time.Time, plan CapturePlan) *Meeting {
	return &Meeting{
		ID:        id,
		StartedAt: startedAt,
		Provider:  plan.Provider,
		Languages: plan.Languages,
		Meta:      map[string]string{},
	}
}

// AppendFinal records a final event as an utterance, coalescing it into the
// previous one when the same speaker continues speaking (engines emit one final
// per short segment, which otherwise fragments a single turn mid-sentence).
func (m *Meeting) AppendFinal(ev TranscriptEvent) {
	text := strings.TrimSpace(ev.Text)
	if text == "" {
		return
	}
	if n := len(m.Utterances); n > 0 && m.Utterances[n-1].Speaker == ev.Speaker {
		last := &m.Utterances[n-1]
		last.Text = strings.TrimSpace(strings.Join([]string{last.Text, text}, " "))
		if ev.TsMs > last.Span.EndMs {
			last.Span.EndMs = ev.TsMs
		}
		return
	}
	m.Utterances = append(m.Utterances, Utterance{
		Speaker:  ev.Speaker,
		Text:     text,
		Span:     TimeRange{StartMs: ev.TsMs, EndMs: ev.TsMs},
		Channel:  ev.Channel,
		Provider: m.Provider,
	})
}

// Transcript renders the utterances into a readable transcript, prefixing each
// line with its speaker label when one is present.
func (m *Meeting) Transcript() string {
	var b strings.Builder
	for _, u := range m.Utterances {
		if u.Speaker != "" {
			b.WriteString(u.Speaker)
			b.WriteString(": ")
		}
		b.WriteString(u.Text)
		b.WriteByte('\n')
	}
	return b.String()
}

// Duration is the recorded wall-clock length once ended.
func (m *Meeting) Duration() time.Duration {
	if m.EndedAt.IsZero() {
		return 0
	}
	return m.EndedAt.Sub(m.StartedAt)
}
