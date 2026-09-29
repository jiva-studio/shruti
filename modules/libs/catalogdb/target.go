package catalogdb

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// The target_id of an attribution reference is a string whose shape depends on
// the reference kind. A verse or document reference holds the row id itself; a
// title and a lecture fragment are addressed by a composite the chat service
// parses back, so both are built and read here only.

// TitleTarget addresses a chapter or canto heading in library_titles, in any
// language: "<source_id>/<tokens>".
type TitleTarget struct {
	SourceID string
	Tokens   string
}

// NewTitleTarget validates a title address and normalises its tokens.
func NewTitleTarget(sourceID, tokens string) (TitleTarget, error) {
	sourceID = strings.TrimSpace(sourceID)
	tokens = NormalizeTokens(tokens)
	if sourceID == "" || tokens == "" {
		return TitleTarget{}, errors.New("title target needs a source id and tokens")
	}
	if strings.Contains(sourceID, "/") {
		return TitleTarget{}, fmt.Errorf("title target source id %q contains '/'", sourceID)
	}
	return TitleTarget{SourceID: sourceID, Tokens: tokens}, nil
}

// ParseTitleTarget reads "<source_id>/<tokens>". Source ids never contain '/',
// so the address splits on the first one.
func ParseTitleTarget(s string) (TitleTarget, error) {
	sourceID, tokens, ok := strings.Cut(s, "/")
	if !ok {
		return TitleTarget{}, fmt.Errorf("title target must be \"<source_id>/<tokens>\", got %q", s)
	}
	return NewTitleTarget(sourceID, tokens)
}

func (t TitleTarget) String() string { return t.SourceID + "/" + t.Tokens }

// TrackTarget addresses a fragment of a lecture by time range:
// "<track_id>@<start_ms>-<end_ms>". A whole lecture is never a target — it
// covers many subjects, so an attribution names a passage.
type TrackTarget struct {
	TrackID string
	StartMs int
	EndMs   int
}

// NewTrackTarget validates a fragment address.
func NewTrackTarget(trackID string, startMs, endMs int) (TrackTarget, error) {
	trackID = strings.TrimSpace(trackID)
	switch {
	case trackID == "":
		return TrackTarget{}, errors.New("track target needs a track id")
	case strings.Contains(trackID, "@"):
		return TrackTarget{}, fmt.Errorf("track target id %q contains '@'", trackID)
	case startMs < 0 || endMs < startMs:
		return TrackTarget{}, fmt.Errorf("track target range %d-%d must satisfy 0 <= start <= end", startMs, endMs)
	}
	return TrackTarget{TrackID: trackID, StartMs: startMs, EndMs: endMs}, nil
}

// ParseTrackTarget reads "<track_id>@<start_ms>-<end_ms>".
func ParseTrackTarget(s string) (TrackTarget, error) {
	trackID, span, ok := strings.Cut(s, "@")
	if !ok {
		return TrackTarget{}, fmt.Errorf("track target must be \"<track_id>@<start_ms>-<end_ms>\", got %q", s)
	}
	start, end, ok := strings.Cut(span, "-")
	if !ok {
		return TrackTarget{}, fmt.Errorf("track target must be \"<track_id>@<start_ms>-<end_ms>\", got %q", s)
	}
	startMs, err := strconv.Atoi(start)
	if err != nil {
		return TrackTarget{}, fmt.Errorf("track target start in %q: %w", s, err)
	}
	endMs, err := strconv.Atoi(end)
	if err != nil {
		return TrackTarget{}, fmt.Errorf("track target end in %q: %w", s, err)
	}
	return NewTrackTarget(trackID, startMs, endMs)
}

func (t TrackTarget) String() string {
	return fmt.Sprintf("%s@%d-%d", t.TrackID, t.StartMs, t.EndMs)
}

// NormalizeTokens puts a reference position into the form the library stores:
// trimmed, en and em dashes as ASCII hyphens, and leading zeros dropped from
// every numeric component ("02.013" is "2.13"). A range keeps both ends.
func NormalizeTokens(raw string) string {
	t := strings.NewReplacer("–", "-", "—", "-").Replace(strings.TrimSpace(raw))
	ends := strings.Split(t, "-")
	for i, end := range ends {
		parts := strings.Split(end, ".")
		for j, p := range parts {
			if n, err := strconv.Atoi(p); err == nil && n >= 0 {
				parts[j] = strconv.Itoa(n)
			}
		}
		ends[i] = strings.Join(parts, ".")
	}
	return strings.Join(ends, "-")
}
