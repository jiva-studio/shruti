package glossary

import (
	"strings"
	"unicode"
)

// diacriticMap collapses IAST and a few Russian variants down to their
// base ASCII/Cyrillic letters. We strip diacritics for matching ONLY;
// the canonical form returned to the LLM keeps them intact (so the
// model uses the proper IAST output spelling).
var diacriticMap = map[rune]rune{
	'ā': 'a', 'Ā': 'a', 'ă': 'a',
	'ī': 'i', 'Ī': 'i',
	'ū': 'u', 'Ū': 'u',
	'ē': 'e', 'Ē': 'e',
	'ō': 'o', 'Ō': 'o',
	'ṛ': 'r', 'Ṛ': 'r', 'ṝ': 'r', 'ṟ': 'r',
	'ḷ': 'l', 'Ḷ': 'l',
	'ṣ': 's', 'Ṣ': 's', 'ś': 's', 'Ś': 's',
	'ṇ': 'n', 'Ṇ': 'n', 'ñ': 'n', 'Ñ': 'n', 'ṅ': 'n', 'Ṅ': 'n',
	'ṁ': 'm', 'Ṁ': 'm', 'ṃ': 'm', 'Ṃ': 'm',
	'ḥ': 'h', 'Ḥ': 'h',
	'ṭ': 't', 'Ṭ': 't',
	'ḍ': 'd', 'Ḍ': 'd',
	'ё': 'е', 'Ё': 'е',
}

// normalize lowercases s, strips diacritics via diacriticMap, and drops
// every non-letter (hyphens, spaces, punctuation, digits). Result is a
// dense letter-only string we can feed to the trigram extractor.
//
// "Bhagavad-gītā" → "bhagavadgita"
// "Бхагават-гите" → "бхагаватгите"
// "Шри Чайтанья Махапрабху" → "шричайтаньямахапрабху"
func normalize(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if repl, ok := diacriticMap[r]; ok {
			r = repl
		}
		if !unicode.IsLetter(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// trigrams returns the sliding 3-character windows of s. Padding is
// added on both sides so prefix/suffix substrings still produce
// trigrams (helps short canonicals).
//
// "бхагав" → ["##б", "#бх", "бха", "хаг", "ага", "гав", "ав#", "в##"]
func trigrams(s string) []string {
	if s == "" {
		return nil
	}
	runes := []rune(s)
	if len(runes) < 3 {
		// short word: pad with sentinels so we still get trigrams
		runes = append([]rune{'#', '#'}, runes...)
		runes = append(runes, '#', '#')
	}
	out := make([]string, 0, len(runes))
	for i := 0; i+3 <= len(runes); i++ {
		out = append(out, string(runes[i:i+3]))
	}
	return out
}
