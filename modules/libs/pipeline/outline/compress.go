package outline

import (
	"strings"
	"unicode"
)

// Compressor shortens one block's text before it is sent to the model. It sees
// the text alone — the time-code is attached afterwards, so no compressor can
// eat the marker it is anchored to.
//
// A nil Compressor means send the text as written.
type Compressor interface {
	Compress(text string) string
}

// CompressorFunc adapts a plain function to Compressor.
type CompressorFunc func(string) string

func (f CompressorFunc) Compress(text string) string { return f(text) }

// dropPunctuation removes the marks that carry no meaning for this task: the
// model is asked what a passage is about, not where a sentence ended. Measured
// at 12% of the input on this corpus, with no change to the headings produced.
//
// Digits, letters and the marks inside words (hyphen in "Бхагавад-гита",
// apostrophe in transliteration) survive.
var dropPunctuation = CompressorFunc(func(text string) string {
	var b strings.Builder
	b.Grow(len(text))
	space := true // leading run collapses away
	for _, r := range text {
		switch {
		case unicode.IsSpace(r):
			if !space {
				b.WriteRune(' ')
				space = true
			}
		case isKept(r):
			b.WriteRune(r)
			space = false
		}
	}
	return strings.TrimSpace(b.String())
})

func isKept(r rune) bool {
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		return true
	}
	// Kept because they sit inside words rather than between them.
	return r == '-' || r == '\'' || r == 'ʼ' || r == '’'
}

// CompressorByName resolves the configured compression mode. Unknown names
// return nil, ok=false so a typo in config fails loudly instead of silently
// sending uncompressed text.
func CompressorByName(name string) (Compressor, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "none", "off":
		return nil, true
	case "punctuation":
		return dropPunctuation, true
	default:
		return nil, false
	}
}
