package extract

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// parseJSON flattens an API response the same way a page is flattened: every
// value becomes text, every media address becomes an item. Which key a source
// happens to call its title is the normalizer's problem, not ours.
func parseJSON(raw []byte, pageURL string) (*domain.Extraction, error) {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil, err
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}

	f := &flattener{base: base}
	f.value("", payload)

	out := &domain.Extraction{
		PageText: f.text(),
		Links:    f.links,
	}
	out.Items = itemsFromMarks(f.marks, out.PageText, pageURL)
	return out, nil
}

// value walks the decoded document, writing "key: value" lines so the text
// keeps the labels the source gave its fields.
func (f *flattener) value(key string, v any) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			f.value(k, t[k])
		}
	case []any:
		for _, item := range t {
			f.value(key, item)
			f.newline()
		}
	case string:
		f.scalar(key, t)
	case float64:
		f.scalar(key, strconv.FormatFloat(t, 'f', -1, 64))
	case bool:
		f.scalar(key, strconv.FormatBool(t))
	}
}

func (f *flattener) scalar(key, s string) {
	if s = strings.TrimSpace(s); s == "" {
		return
	}
	if looksLikeURL(s) {
		if abs := absolute(f.base, s); abs != "" {
			if IsMediaURL(abs) {
				f.addMark(abs)
			} else {
				f.addLink(abs)
			}
		}
	}
	f.newline()
	if key != "" {
		f.write(key + ": ")
	}
	f.write(stripTags(s))
}

func looksLikeURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") ||
		strings.HasPrefix(s, "/")
}

// stripTags removes markup from values that arrive as embedded HTML, which
// JSON APIs routinely do for rendered fields.
func stripTags(s string) string {
	if !strings.Contains(s, "<") {
		return s
	}
	var sb strings.Builder
	depth := 0
	for _, r := range s {
		switch {
		case r == '<':
			depth++
		case r == '>' && depth > 0:
			depth--
			sb.WriteByte(' ')
		case depth == 0:
			sb.WriteRune(r)
		}
	}
	return clean(sb.String())
}
