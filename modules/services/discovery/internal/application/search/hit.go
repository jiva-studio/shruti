package search

import (
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// HitCollection places a recording inside its cycle: which one, and which part.
//
// ID is what to hand back as collection= to get the rest of the cycle. A title
// would usually work and is the wrong handle: two sources can name a cycle the
// same, and a name can be edited.
type HitCollection struct {
	ID      int64  `json:"id"`
	Title   string `json:"title"`
	URL     string `json:"url,omitempty"`
	Ordinal int    `json:"ordinal"`
	Of      int    `json:"of"`
}

// Hit is one recording, with the piece of text that matched.
type Hit struct {
	ItemID   int64  `json:"item_id"`
	MediaURL string `json:"media_url"`
	PageURL  string `json:"page_url,omitempty"`
	Title    string `json:"title,omitempty"`
	Author   string `json:"author,omitempty"`
	Location string `json:"location,omitempty"`
	Language string `json:"language,omitempty"`
	// CoverURL is the picture the archive publishes, as the script that read
	// the page said it. A caller shows it and needs to know nothing about which
	// archives have pictures or how each builds an address for one.
	CoverURL   string     `json:"cover_url,omitempty"`
	RecordedOn *time.Time `json:"recorded_on,omitempty"`
	References []string   `json:"references,omitempty"`
	Source     string     `json:"source,omitempty"`
	// Collection is the cycle this recording is a part of, and where in it.
	Collection *HitCollection `json:"collection,omitempty"`
	Chunk      string         `json:"chunk,omitempty"`
	Summary    string         `json:"summary,omitempty"`
	Highlight  string         `json:"highlight,omitempty"`
	Score      float64        `json:"score"`

	// MediaState says what the last visit saw of the file. Search answers only
	// with what is still offered.
	MediaState string `json:"media_state,omitempty"`
}

// hitsFrom keeps a nil list nil, so "nothing found" encodes as null.
func hitsFrom(found []domain.Hit, queryText string) []Hit {
	if found == nil {
		return nil
	}
	out := make([]Hit, 0, len(found))
	for _, h := range found {
		hl := h.Highlight
		if hl == "" && h.Chunk != "" {
			hl = domain.ExtractSnippet(h.Chunk, queryText, 220)
		}
		hit := Hit{
			ItemID:     h.ItemID,
			MediaURL:   h.MediaURL,
			PageURL:    h.PageURL,
			Title:      h.Title,
			Author:     h.Author,
			Location:   h.Location,
			Language:   h.Language,
			CoverURL:   h.CoverURL,
			RecordedOn: h.RecordedOn,
			References: h.References,
			Source:     h.Source,
			Chunk:      h.Chunk,
			Summary:    h.Summary,
			Highlight:  hl,
			Score:      h.Score,
			MediaState: h.MediaState,
		}
		if c := h.Collection; c != nil {
			hit.Collection = &HitCollection{ID: c.ID, Title: c.Title, URL: c.URL, Ordinal: c.Ordinal, Of: c.Of}
		}
		out = append(out, hit)
	}
	return out
}
