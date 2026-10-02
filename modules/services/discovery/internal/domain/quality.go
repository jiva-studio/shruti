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

// ExtractSnippet extracts a compact excerpt (~maxRunes length) from a chunk around
// the matching search query keywords.
func ExtractSnippet(chunkText, queryText string, maxRunes int) string {
	chunkText = strings.TrimSpace(chunkText)
	if chunkText == "" {
		return ""
	}
	if maxRunes <= 0 {
		maxRunes = 220
	}

	// Clean excessive newlines and whitespace into single spaces
	cleaned := strings.Join(strings.Fields(chunkText), " ")
	runes := []rune(cleaned)
	if len(runes) <= maxRunes {
		return cleaned
	}

	queryLower := strings.ToLower(strings.TrimSpace(queryText))
	queryWords := strings.Fields(queryLower)

	matchPos := -1
	cleanedLower := strings.ToLower(cleaned)
	for _, word := range queryWords {
		word = strings.TrimFunc(word, func(r rune) bool {
			return unicode.IsPunct(r) || unicode.IsSpace(r)
		})
		if len([]rune(word)) < 3 {
			continue
		}
		if idx := strings.Index(cleanedLower, word); idx != -1 {
			matchPos = len([]rune(cleanedLower[:idx]))
			break
		}
	}

	var start, end int
	if matchPos == -1 {
		start = 0
		end = min(maxRunes, len(runes))
	} else {
		half := maxRunes / 2
		start = max(0, matchPos-half)
		end = min(len(runes), start+maxRunes)
		if end-start < maxRunes && start > 0 {
			start = max(0, end-maxRunes)
		}
	}

	// Snap start to next word boundary if not at 0
	if start > 0 {
		for start < end && !unicode.IsSpace(runes[start]) {
			start++
		}
		if start < end && unicode.IsSpace(runes[start]) {
			start++
		}
	}

	// Snap end to previous word boundary if not at end
	if end < len(runes) {
		for end > start && !unicode.IsSpace(runes[end]) {
			end--
		}
	}

	snippet := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet += "..."
	}

	return snippet
}
