package extract

import (
	"strings"
	"unicode"

	"github.com/abadojack/whatlanggo"
)

// TextSearchConfig detects the natural language of the input text and maps it to a
// supported PostgreSQL full-text search configuration. If the language has no built-in
// Postgres dictionary or cannot be confidently detected, "simple" is returned.
func TextSearchConfig(text string) string {
	cleaned := strings.TrimSpace(text)
	if cleaned == "" {
		return "simple"
	}

	info := whatlanggo.Detect(cleaned)
	switch info.Lang {
	case whatlanggo.Rus, whatlanggo.Ukr, whatlanggo.Bel, whatlanggo.Bul, whatlanggo.Srp:
		return "russian"
	case whatlanggo.Eng:
		return "english"
	case whatlanggo.Spa:
		return "spanish"
	case whatlanggo.Fra:
		return "french"
	case whatlanggo.Deu:
		return "german"
	case whatlanggo.Ita:
		return "italian"
	case whatlanggo.Por:
		return "portuguese"
	case whatlanggo.Nld:
		return "dutch"
	case whatlanggo.Swe:
		return "swedish"
	case whatlanggo.Nob, whatlanggo.Nno:
		return "norwegian"
	case whatlanggo.Dan:
		return "danish"
	case whatlanggo.Fin:
		return "finnish"
	case whatlanggo.Hun:
		return "hungarian"
	case whatlanggo.Ron:
		return "romanian"
	case whatlanggo.Tur:
		return "turkish"
	case whatlanggo.Arb:
		return "arabic"
	case whatlanggo.Ind:
		return "indonesian"
	default:
		if info.Script == unicode.Cyrillic {
			return "russian"
		}
		return "simple"
	}
}
