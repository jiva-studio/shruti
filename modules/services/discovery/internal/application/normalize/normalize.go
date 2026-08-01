// Package normalize turns what a page literally said into what a recording
// actually is.
//
// Extraction never guesses meaning, so everything interpreted arrives here:
// which part of a filename is the speaker, whether "29.12.13" is a date or a
// verse, what language is being spoken. A model reads the raw material and
// answers; this package decides whether to believe the answer.
package normalize

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Input is one media file's raw material.
type Input struct {
	MediaURL     string            `json:"media_url"`
	Filename     string            `json:"filename,omitempty"`
	PathSegments []string          `json:"path_segments,omitempty"`
	Context      string            `json:"context,omitempty"`
	Tags         map[string]string `json:"tags,omitempty"`
}

// Batch is the files found on one page, which share that page's context.
//
// Batching is the cost lever: files in one directory or on one listing share
// everything except their own filename, so one call covers many of them.
type Batch struct {
	PageURL   string  `json:"page_url,omitempty"`
	PageTitle string  `json:"page_title,omitempty"`
	Items     []Input `json:"items"`
}

// Result is what the model said about one file, after validation.
type Result struct {
	Title     string `json:"title,omitempty"`
	Author    string `json:"author,omitempty"`
	Location  string `json:"location,omitempty"`
	Date      string `json:"date,omitempty"` // YYYY-MM-DD
	Language  string `json:"language,omitempty"`
	DurationS int    `json:"duration_s,omitempty"`
	// References is one entry per verse: a range in a filename is expanded
	// before it gets here, the same way the corpus parser does it.
	References []domain.Ref `json:"references,omitempty"`

	// CollectionTitle is what this recording's own page called the cycle it
	// belongs to. On archives with no page for the series it is the only route
	// to the grouping at all.
	CollectionTitle string `json:"collection_title,omitempty"`
}

// SeriesInput is a page that offered no audio, and the links it carries.
type SeriesInput struct {
	PageURL   string
	PageTitle string
	PageText  string
	Links     []string
}

// Series is a page that turned out to present a cycle of recordings.
type Series struct {
	IsSeries    bool   `json:"is_series"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Author      string `json:"author"`
	// Members are the links that are its parts, in the order the page gives
	// them. They are page addresses, not recordings: the parts may not have
	// been indexed yet.
	Members []string `json:"members"`
}

// Normalizer reads raw material and says what it means. The live
// implementation calls a model; the stub returns fixed answers so the rest of
// the pipeline can be tested without a key.
type Normalizer interface {
	Normalize(ctx context.Context, batch Batch) ([]Result, error)
	// Series decides whether a page without audio presents a cycle of
	// recordings, and which links are its parts. Nil means it does not.
	Series(ctx context.Context, in SeriesInput) (*Series, error)
	// PromptVersion changes whenever the prompt does, which invalidates every
	// stored input hash without anyone having to clear a table.
	PromptVersion() string
	Model() string
}

// InputHash identifies one item's normalizer input. Storing it lets a recheck
// of an unchanged page cost zero model calls; bumping the prompt version or
// switching model changes the hash for everything at once.
func InputHash(batch Batch, i int, promptVersion, model string) string {
	payload := struct {
		PageURL       string `json:"page_url"`
		PageTitle     string `json:"page_title"`
		Item          Input  `json:"item"`
		PromptVersion string `json:"prompt_version"`
		Model         string `json:"model"`
	}{batch.PageURL, batch.PageTitle, batch.Items[i], promptVersion, model}

	// Marshal of a struct with fixed field order is stable, and every nested
	// value is either a string, a slice or a map that encoding/json sorts.
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// BatchFor turns an extraction into the normalizer's input. Every file on a
// page goes into one batch because they share that page's context — which is
// what makes normalization affordable at archive scale.
func BatchFor(e *domain.Extraction) Batch {
	batch := Batch{
		PageURL:   e.URL,
		PageTitle: e.PageTitle,
		Items:     make([]Input, 0, len(e.Items)),
	}
	for _, it := range e.Items {
		batch.Items = append(batch.Items, Input{
			MediaURL:     it.MediaURL,
			Filename:     it.Filename,
			PathSegments: it.PathSegments,
			Context:      it.ContextText,
			Tags:         it.Tags,
		})
	}
	return batch
}
