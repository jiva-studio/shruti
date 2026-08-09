package normalize

import (
	"context"
	"path"
	"strings"
	"time"
)

// Stub answers without a model. It is what runs with no key configured and in
// tests, so the whole path — fetch, extract, normalize, store — can be
// exercised for free and deterministically.
//
// It reads nothing into the material. It cleans the filename into a title and
// says nothing else, which is honestly all you can know without interpretation.
type Stub struct{}

func (Stub) PromptVersion() string { return "stub" }
func (Stub) Model() string         { return "stub" }

func (Stub) Normalize(_ context.Context, batch Batch) ([]Result, error) {
	results := make([]Result, len(batch.Items))
	for i, in := range batch.Items {
		r := Result{Title: titleFromFilename(in.Filename)}
		Validate(&r, nil, time.Now())
		results[i] = r
	}
	return results, nil
}

func titleFromFilename(name string) string {
	base := strings.TrimSuffix(name, path.Ext(name))
	base = strings.NewReplacer("_", " ", "-", " ", ".", " ").Replace(base)
	return strings.Join(strings.Fields(base), " ")
}

// Spent is nothing: the stub calls no provider and is billed for none.
func (Stub) Spent() []Spend { return nil }
