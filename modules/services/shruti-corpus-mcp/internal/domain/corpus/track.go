// Package corpus holds the corpus entities the read tools and the search use
// case share: an assembled track and a retrieved chunk. It knows no storage.
package corpus

// conversationTags are the tag ids that make a track a "conversation" rather
// than a "lecture" (the two subtype values the API exposes). The catalog has no
// kind column; the subtype is derived from the tags.
var conversationTags = map[string]bool{
	"tag_morning_walk": true,
	"tag_conversation": true,
	"tag_interview":    true,
	"tag_press_conf":   true,
}

// ConversationTags returns the tag ids that make a track a conversation.
func ConversationTags() []string {
	out := make([]string, 0, len(conversationTags))
	for t := range conversationTags {
		out = append(out, t)
	}
	return out
}

// Reference is one reference a track cites.
type Reference struct {
	SourceID string
	Tokens   string
}

// Track is the assembled per-track metadata.
type Track struct {
	ID          string
	AuthorID    string
	LocationID  string
	Date        string
	Titles      map[string]string // lang -> title
	Durations   map[string]int64  // lang -> audio duration (ms)
	Languages   []string          // variant languages (stable order)
	Transcripts map[string]string // lang -> transcript_path (relative to the media base)
	HasOutline  bool              // any variant has an aligned outline (has_pdf proxy)
	TagIDs      []string
	Refs        []Reference
}

// NewTrack returns a track with empty per-language maps.
func NewTrack(id, authorID, locationID, date string) *Track {
	return &Track{
		ID: id, AuthorID: authorID, LocationID: locationID, Date: date,
		Titles: map[string]string{}, Durations: map[string]int64{}, Transcripts: map[string]string{},
	}
}

// Kind derives lecture|conversation from the track's tags.
func (t *Track) Kind() string {
	for _, tag := range t.TagIDs {
		if conversationTags[tag] {
			return "conversation"
		}
	}
	return "lecture"
}

// Title returns the track title preferring lang, then en, then any variant.
func (t *Track) Title(lang string) string { return Pick(t.Titles, lang) }

// TranscriptPath returns the published transcript artifact for the preferred
// language (then en, then the first variant carrying one) and the language it
// belongs to. Empty when the track has no transcript at all.
func (t *Track) TranscriptPath(lang string) (path, effLang string) {
	if lang != "" {
		if p, ok := t.Transcripts[lang]; ok {
			return p, lang
		}
	}
	if p, ok := t.Transcripts["en"]; ok {
		return p, "en"
	}
	for _, l := range t.Languages {
		if p, ok := t.Transcripts[l]; ok {
			return p, l
		}
	}
	return "", ""
}

// Duration returns the audio duration for the preferred variant language.
func (t *Track) Duration(lang string) int64 {
	if lang != "" {
		if d, ok := t.Durations[lang]; ok {
			return d
		}
	}
	if d, ok := t.Durations["en"]; ok {
		return d
	}
	for _, d := range t.Durations {
		return d
	}
	return 0
}

// HasTranscript reports whether any variant carries a transcript.
func (t *Track) HasTranscript() bool { return len(t.Transcripts) > 0 }

// Cites reports whether the track cites sourceID, at exactly tokens when
// tokens is set.
func (t *Track) Cites(sourceID, tokens string) bool {
	for _, r := range t.Refs {
		if r.SourceID == sourceID && (tokens == "" || r.Tokens == tokens) {
			return true
		}
	}
	return false
}

// Pick returns m[lang], else m["en"], else any value, else "".
func Pick(m map[string]string, lang string) string {
	if lang != "" {
		if v, ok := m[lang]; ok {
			return v
		}
	}
	if v, ok := m["en"]; ok {
		return v
	}
	for _, v := range m {
		return v
	}
	return ""
}
