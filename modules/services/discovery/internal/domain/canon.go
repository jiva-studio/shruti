package domain

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// sources.json is the canon: every scripture the corpus can address a recording
// by, beside every spelling the archives write it in.
//
// A source here is a scripture, which is what the corpus calls one, what the
// client calls one, and what item_refs.source_id holds. It is not a
// store.Source — that is an archive we crawl. Two meanings, one word, and the
// database has carried both since the first migration.
//
// The canon's job is to pin spelling. "Бхагавад-Гита 2.13", "БГ 2.13" and
// "Bhagavad-gita 2.13" are one verse, and stored as written they are three — so
// a list of codes cannot do this work on its own. Nothing in a code says that
// "Шримад Бхагаватам" is SB.
//
// The codes and token schemes come from the corpus. The spellings cannot: the
// corpus dictionary writes Śrīmad-Bhāgavatam with diacritics and ЧЧ Мадхйа with
// an й, and neither of those appears in a single recording we hold. Every name
// below was counted in the titles themselves — "Шримад Бхагаватам" with a space
// rather than a hyphen is 816 of them, and no dictionary would have supplied
// it.
//
//go:embed sources.json
var sourcesJSON []byte

// Source is one addressable scripture.
type Source struct {
	Code string `json:"code"`
	// TokenScheme is how deep a full coordinate goes, in the corpus's own
	// words: "canto.chapter.verse", "chapter.verse" or "flat".
	TokenScheme string   `json:"token_scheme"`
	Names       []string `json:"names"`
}

// Depth is how many numbers a complete coordinate has: three for
// Śrīmad-Bhāgavatam (canto, chapter, verse), two for Bhagavad-gītā, one for a
// flat text. It is what tells a reader where a coordinate ends and the rest of
// the title begins.
func (s Source) Depth() int {
	switch s.TokenScheme {
	case "canto.chapter.verse":
		return 3
	case "flat":
		return 1
	default:
		return 2
	}
}

var sources = func() []Source {
	var out []Source
	if err := json.Unmarshal(sourcesJSON, &out); err != nil {
		panic("domain: sources.json: " + err.Error())
	}
	return out
}()

// Sources is the canon, in the order it is written.
func Sources() []Source { return append([]Source(nil), sources...) }

// SourceCodes are the scriptures this corpus can address a recording by. A
// reference to anything else is an invention, not a citation: it cannot be
// resolved, it cannot be searched for, and stored it is worse than nothing
// because it looks like one.
var SourceCodes = func() []string {
	out := make([]string, 0, len(sources))
	for _, s := range sources {
		out = append(out, s.Code)
	}
	return out
}()

// SourceCodeSet turns a code list into a lookup, upper-cased and trimmed so two
// spellings of one code are one entry.
func SourceCodeSet(codes []string) map[string]bool {
	set := make(map[string]bool, len(codes))
	for _, c := range codes {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			set[c] = true
		}
	}
	return set
}

var knownSources = SourceCodeSet(SourceCodes)

// Addressable reports whether the corpus can address a reference to this
// source.
func Addressable(code string) bool {
	return knownSources[strings.ToUpper(strings.TrimSpace(code))]
}

// SourceByCode finds a source by its canonical code.
func SourceByCode(code string) (Source, bool) {
	code = strings.ToUpper(strings.TrimSpace(code))
	for _, s := range sources {
		if s.Code == code {
			return s, true
		}
	}
	return Source{}, false
}
