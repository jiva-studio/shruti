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

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// Input is one media file's raw material.
//
// The text around the file on the page is deliberately absent: a script reads
// its own source and hands over what it read, labelled, rather than the page
// being scraped blind. Page text also makes the hash worthless, since anything
// on the page that counts or dates itself changes the input on every visit.
type Input struct {
	MediaURL     string            `json:"media_url"`
	Filename     string            `json:"filename,omitempty"`
	PathSegments []string          `json:"path_segments,omitempty"`
	Tags         map[string]string `json:"tags,omitempty"`
	// Material is what the source's own script saw and did not interpret. It is
	// part of the input rather than a hint beside it, so that changing what a
	// script hands over changes the hash and the recordings are read again.
	Material []domain.Material `json:"material,omitempty"`
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

// Result is a reading of one file. Only what somebody worked out lives here;
// what the archive printed travels beside it.
type Result struct {
	Title  string `json:"title,omitempty"`
	Author string `json:"author,omitempty"`
	// Authors is everyone who spoke, when more than one did. Author stays as
	// the one written on the recording.
	Authors  []string `json:"authors,omitempty"`
	Location string   `json:"location,omitempty"`
	Date     string   `json:"date,omitempty"` // YYYY-MM-DD
	Language string   `json:"language,omitempty"`
	// References is one entry per verse: a range in a filename is expanded
	// before it gets here, the same way the corpus parser does it.
	References []domain.Ref `json:"references,omitempty"`

	// Unanswered says the model dropped this file from its reply, which is not
	// the same as answering that it knows nothing. Stored as an answer, silence
	// is stamped with the input hash and never asked about again. Only the
	// reader of a reply can tell the two apart, so only it sets this.
	Unanswered bool `json:"-"`
}

// Spend is what one call cost, as the provider reported it. Every reply
// carries this and the service was throwing it away, so every statement about
// what indexing costs has been arithmetic rather than a bill.
type Spend struct {
	// Kind is which question was asked, so that what indexing costs can be
	// counted per kind of call rather than in one total.
	Kind  string
	Model string
	Items int
	// Reported says whether the provider sent any usage at all. Without it a
	// zero cost cannot be told from a silent one.
	Reported  bool
	TokensIn  int64
	TokensOut int64
	CostUSD   float64
}

// Normalizer reads raw material and says what it means. The live
// implementation calls a model; the stub returns fixed answers so the rest of
// the pipeline can be tested without a key.
type Normalizer interface {
	Normalize(ctx context.Context, batch Batch) ([]Result, error)
	// PromptVersion changes whenever the prompt does, which invalidates every
	// stored input hash without anyone having to clear a table.
	PromptVersion() string
	Model() string
	// Spent returns what has been billed since the last call to it, so a caller
	// can attribute cost to the page it was reading.
	Spent() []Spend
}

// InputHash identifies one item's normalizer input. Storing it lets a recheck
// of an unchanged page cost zero model calls; bumping the prompt version or
// switching model changes the hash for everything at once.
//
// The page's own address and title are not in it: the model is not shown them,
// and a listing whose title carries a counter marks every recording on it
// unread again on every visit.
func InputHash(batch Batch, i int, promptVersion, model string) string {
	payload := struct {
		Item          Input  `json:"item"`
		PromptVersion string `json:"prompt_version"`
		Model         string `json:"model"`
	}{batch.Items[i], promptVersion, model}

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
// page goes into one batch because they share that page — which is what makes
// normalization affordable at archive scale.
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
			Tags:         it.Tags,
		})
	}
	return batch
}
