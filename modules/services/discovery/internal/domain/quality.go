package domain

import (
	"strings"
	"unicode"
)

// IsSearchableTranscript reports whether a transcript contains coherent, searchable lecture
// speech rather than repetitive chanting, pure japa sessions, or ASR noise.
//
// Repetitive chanting sessions (e.g. 64 rounds of Japa repeating the Mahamantra)
// have extreme token repetition where a handful of unique words (3-10) constitute
// nearly the entire text. Indexing them pollutes lexical and vector search with noise.
func IsSearchableTranscript(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}

	words := strings.FieldsFunc(text, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsPunct(r)
	})
	if len(words) < 20 {
		return true
	}

	freq := make(map[string]int, len(words)/2)
	noiseTagTokens := 0
	for _, w := range words {
		lw := strings.ToLower(w)
		if lw == "संगीत" || lw == "music" || lw == "applause" || lw == "laughter" || lw == "تصفيق" || lw == "موسيقى" {
			noiseTagTokens++
		}
		freq[lw]++
	}

	// If > 30% of words are YouTube music / applause tags, reject as noise
	if float64(noiseTagTokens)/float64(len(words)) > 0.30 {
		return false
	}

	// Calculate Type-Token Ratio (unique words / total words)
	ttr := float64(len(freq)) / float64(len(words))

	// For longer texts (>= 100 words), pure japa / chanting exhibits TTR < 0.06
	// and top-3 word concentration > 50%.
	if len(words) >= 100 {
		if ttr < 0.06 {
			var top1, top2, top3 int
			for _, count := range freq {
				switch {
				case count > top1:
					top3, top2, top1 = top2, top1, count
				case count > top2:
					top3, top2 = top2, count
				case count > top3:
					top3 = count
				}
			}
			top3Total := top1 + top2 + top3
			if float64(top3Total)/float64(len(words)) > 0.50 {
				return false
			}
		}
	}

	return true
}
