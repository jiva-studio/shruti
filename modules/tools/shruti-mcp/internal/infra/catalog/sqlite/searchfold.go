package sqlitecatalog

import "strings"

// foldSearchText folds a string into the form `tracks_search` indexes.
//
// `unicode61` folds case and strips Latin diacritics, but leaves Cyrillic
// `ё` (U+0451) as a term of its own — so a title spelled "учёные" was
// unreachable for a user who typed "ученые", the spelling most Russian
// keyboards produce. Folding here makes the index carry the `е` form; the
// mobile query builder folds identically
// (`infra/repositories/sql/tracksRepository.sql.ts`, foldSearchText), so
// both spellings of a query hit both spellings of a title.
var searchFolder = strings.NewReplacer("ё", "е", "Ё", "Е")

func foldSearchText(s string) string {
	return searchFolder.Replace(s)
}
