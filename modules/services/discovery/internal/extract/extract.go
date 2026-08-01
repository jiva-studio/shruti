// Package extract turns a fetched response into flat text and a list of media
// files found in it.
//
// It knows nothing about any website and has no notion of page layout. A
// response is flattened to the text a reader would see, every media URL in it
// is collected, and each one carries the text around the place it appeared.
// What any of that means — speaker, date, scripture reference, title — is
// decided later by the normalizer, from the text.
package extract

import (
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Parse reads a response of any type we can make text out of.
func Parse(raw []byte, contentType, pageURL string) (*domain.Extraction, error) {
	var (
		out *domain.Extraction
		err error
	)
	if isJSON(contentType, raw) {
		out, err = parseJSON(raw, pageURL)
	} else {
		out, err = parseHTML(raw, contentType, pageURL)
	}
	if err != nil {
		return nil, err
	}
	out.URL = pageURL
	out.FetchedAt = time.Now().UTC()
	assignTextRole(out)
	return out, nil
}

func isJSON(contentType string, raw []byte) bool {
	if strings.Contains(strings.ToLower(contentType), "json") {
		return true
	}
	trimmed := strings.TrimLeft(string(raw[:min(len(raw), 64)]), " \t\r\n")
	return strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")
}

// assignTextRole records how specific the page text is to each item: a page
// carrying one recording describes it, a page carrying ten carries something
// they share.
func assignTextRole(e *domain.Extraction) {
	switch len(e.Items) {
	case 0:
	case 1:
		e.Items[0].TextRole = domain.TextCanonical
	default:
		for i := range e.Items {
			e.Items[i].TextRole = domain.TextShared
		}
	}
}
