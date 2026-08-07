package domain

import "strings"

// ScriptureCodes are the books this corpus can address a recording by. A
// reference to anything else is an invention, not a citation: it cannot be
// resolved, it cannot be searched for, and stored it is worse than nothing
// because it looks like one.
//
// It lives here rather than beside the one caller that used to have it because
// this is knowledge about the corpus, not about reading a page or reading a
// question. Both of those now need it.
//
// This list held eight books and the corpus holds nineteen. The nine that were
// missing were not merely unlisted: a citation to any of them was taken for an
// invention and dropped, so every reference to the Nectar of Instruction, the
// Ramayana or Prabhupada's letters that a lecture made was thrown away, and the
// throwing away leaves no trace.
//
// It is still a copy of a list that lives in the corpus, and a copy drifts. The
// corpus also writes them differently — "CC Madhya" where this writes
// "CC_MADHYA", "NoI" where this writes "NOI" — so a reference found here does
// not travel there without translation. Both are worth fixing at the seam
// rather than by copying harder.
var ScriptureCodes = []string{
	"BG", "SB",
	"CC_ADI", "CC_MADHYA", "CC_ANTYA",
	"ISO", "NOD", "NOI", "BS", "NBS", "MM",
	"TQK", "TLC", "KB", "RMN", "MK", "LETTERS",
}

// ScriptureCodeSet turns a code list into a lookup, upper-cased and trimmed so
// two spellings of one book are one entry.
func ScriptureCodeSet(codes []string) map[string]bool {
	set := make(map[string]bool, len(codes))
	for _, c := range codes {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			set[c] = true
		}
	}
	return set
}

// knownScripture is the default set, built once.
var knownScripture = ScriptureCodeSet(ScriptureCodes)

// Addressable reports whether the corpus can address a reference to this book.
func Addressable(code string) bool {
	return knownScripture[strings.ToUpper(strings.TrimSpace(code))]
}
