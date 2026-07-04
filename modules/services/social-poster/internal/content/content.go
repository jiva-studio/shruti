// Package content turns a chosen Candidate into publishable material: the
// formatted caption and, via share-audio, a public mp3 excerpt URL.
package content

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/jiva-studio/shruti-social-poster/internal/catalog"
	"github.com/jiva-studio/shruti-social-poster/internal/config"
)

// DefaultLectureExcerptMs is the excerpt length used for lecture content
// when a campaign doesn't set filters.excerpt_ms.
const DefaultLectureExcerptMs int64 = 120000

// Content is the built material shared across a candidate's targets. The
// per-target poster image / audio ref are added later by the orchestrator.
type Content struct {
	Candidate catalog.Candidate
	Text      string // formatted caption
	AudioURL  string // public mp3 excerpt
	Title     string // audio title
	Artist    string // audio performer
}

type Builder struct {
	audioClients map[string]*ShareAudioClient // region -> client
}

// NewBuilder wires a share-audio client per region.
func NewBuilder(cfg *config.Config, httpc *http.Client) *Builder {
	b := &Builder{audioClients: map[string]*ShareAudioClient{}}
	for name, r := range cfg.Catalog.Regions {
		if r.ShareAudioBase != "" {
			b.audioClients[name] = NewShareAudioClient(r.ShareAudioBase, httpc)
		}
	}
	return b
}

// Build produces the shared Content for a candidate in a region. When
// needAudio is false (no audio-bearing target in the campaign) the
// share-audio cut is skipped and AudioURL is left empty.
func (b *Builder) Build(ctx context.Context, region string, c catalog.Candidate, excerptMs int64, needAudio bool) (Content, error) {
	out := Content{
		Candidate: c,
		Text:      caption(c),
		Title:     audioTitle(c),
		Artist:    c.Author,
	}
	if !needAudio {
		return out, nil
	}

	client := b.audioClients[region]
	if client == nil {
		return Content{}, fmt.Errorf("no share-audio client for region %q", region)
	}
	start, end := excerptBounds(c, excerptMs)
	url, err := client.Excerpt(ctx, c.AudioPath, start, end, excerptID(c, start, end))
	if err != nil {
		return Content{}, err
	}
	out.AudioURL = url
	return out, nil
}

// excerptBounds returns the [start,end) to cut. Wisdom carries its own
// bounds; a lecture is cut from the start for excerptMs (clamped to its
// audio duration).
func excerptBounds(c catalog.Candidate, excerptMs int64) (int64, int64) {
	if c.Kind == config.ContentDailyWisdom && c.EndMs > c.StartMs {
		return c.StartMs, c.EndMs
	}
	if excerptMs <= 0 {
		excerptMs = DefaultLectureExcerptMs
	}
	end := excerptMs
	if c.DurationMs > 0 && end > c.DurationMs {
		end = c.DurationMs
	}
	return 0, end
}

// excerptID mirrors the chat client's citationExcerptId scheme
// (chat-cite-<track>-<start>-<end>) so share-audio cache hits are shared:
// a daily_wisdom excerpt is the same cut the client / cut_audio.py already
// produced, so this resolves instantly instead of re-cutting.
func excerptID(c catalog.Candidate, start, end int64) string {
	return sanitizeID(fmt.Sprintf("chat-cite-%s-%d-%d", c.TrackID, start, end))
}

func sanitizeID(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := b.String()
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func audioTitle(c catalog.Candidate) string {
	if c.TopicName != "" {
		return c.TopicName
	}
	return c.Title
}

// caption formats the post text. Author/location/topic come already
// localized in the candidate's language.
func caption(c catalog.Candidate) string {
	var b strings.Builder
	switch c.Kind {
	case config.ContentDailyWisdom:
		b.WriteString(strings.TrimSpace(c.Text))
	default:
		if c.Title != "" {
			b.WriteString(c.Title)
			b.WriteString("\n")
		}
		if snip := snippet(c.Text, 400); snip != "" {
			b.WriteString("\n")
			b.WriteString(snip)
		}
	}

	if attr := attribution(c); attr != "" {
		b.WriteString("\n\n")
		b.WriteString(attr)
	}
	return strings.TrimSpace(b.String())
}

func attribution(c catalog.Candidate) string {
	var parts []string
	if c.Author != "" {
		parts = append(parts, "— "+c.Author)
	}
	var place []string
	if c.Location != "" {
		place = append(place, c.Location)
	}
	if c.Date != "" {
		place = append(place, c.Date)
	}
	if len(place) > 0 {
		parts = append(parts, strings.Join(place, ", "))
	}
	return strings.Join(parts, "\n")
}

func snippet(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	if i := strings.LastIndexByte(cut, ' '); i > max/2 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}
