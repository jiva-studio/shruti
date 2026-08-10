package sqlitecatalog

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// foldSearchText folds a string into the form `tracks_search` indexes.
//
// `unicode61` folds case and strips Latin diacritics, but leaves Cyrillic
// `ё` (U+0451) as a term of its own — so a title spelled "учёные" was
// unreachable for a user who typed "ученые", the spelling most Russian
// keyboards produce.
//
// Combining marks are the other half. `unicode61` treats them as part of the
// word and deletes them, so a title carrying a decomposed `й` was indexed as
// "настроика" and no spelling of "Настройка" could reach it; marks outside
// its diacritic table — a Devanagari matra, an Arabic harakat — instead cut
// the word into single consonants. Folding here settles both: Latin and Greek
// marks go the way `unicode61` takes them, everything else is re-composed
// first so `й ё ї ў` survive as themselves, and whatever is left over is
// dropped without splitting the word.
//
// The mobile query builder folds identically
// (`infra/repositories/sql/tracksRepository.sql.ts`, foldSearchText), so both
// spellings of a query hit both spellings of a title.
var searchFolder = strings.NewReplacer("ё", "е", "Ё", "Е")

func foldSearchText(s string) string {
	var b strings.Builder
	latinOrGreek := false
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.M, r) {
			if !latinOrGreek {
				b.WriteRune(r)
			}
			continue
		}
		latinOrGreek = unicode.Is(unicode.Latin, r) || unicode.Is(unicode.Greek, r)
		b.WriteRune(r)
	}
	unmarked := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.M, r) {
			return -1
		}
		return r
	}, norm.NFC.String(b.String()))
	return searchFolder.Replace(unmarked)
}
