package domain

import (
	"regexp"
	"sort"
	"strings"
)

// Refs reads the scripture references out of a line of text.
//
// "Парататтва дас - Шримад Бхагаватам 4.9.32. - 18.06.2024" is a reference to
// SB 4.9.32 and a date, and telling them apart is the whole job. Nothing here
// asks a model: the archives that need this most never reach one, because their
// scripts answer completely and the normalizer is only asked about what a
// script could not read.
//
// Tokens come back as the line wrote them — "4.9.32", "13.148-150" — and become
// one Ref per verse through ExpandRefs, which stays the one place that decides
// what a range means and the one place that can say it collapsed a range.
func Refs(text string) []Ref {
	cites := Cites(text)
	out := make([]Ref, 0, len(cites))
	for _, c := range cites {
		out = append(out, c.Ref)
	}
	return out
}

// Citation is a reference and where it was written, so a caller taking a title
// apart can cut it out and keep what is left.
type Citation struct {
	Ref   Ref
	Start int
	End   int
}

// Cites finds every reference in the text, in the order they appear.
//
// Every occurrence is looked at, not the first: "Лекции по Шримад Бхагаватам |
// ШБ 4.29.64" names the book twice and only the second naming carries the
// coordinate. Stopping at the first would lose 342 references in the corpus we
// hold.
//
// A source named with no coordinate beside it is being talked about, not cited:
// "Glories of Srimad Bhagavatam" is a title.
func Cites(text string) []Citation {
	var out []Citation
	cited := map[string]bool{}
	for _, m := range nameRe.FindAllStringSubmatchIndex(text, -1) {
		start, end := m[2], m[3]
		src, ok := sourceByName[foldName(text[start:end])]
		if !ok || cited[src.Code] {
			// One line cites one scripture once. A second coordinate for a
			// scripture already cited is, every time we have looked, the date.
			continue
		}
		parts, width := coordinate(text[end:], src.Depth())
		if len(parts) == 0 {
			continue
		}
		cited[src.Code] = true
		out = append(out, Citation{
			Ref:   Ref{Source: src.Code, Tokens: coordinateTokens(parts, src.Depth())},
			Start: start,
			End:   end + width,
		})
	}
	return out
}

// coordinate reads the numbers belonging to a source named just before it, and
// returns them with how much of the text they took.
//
// The rule is one rule for every archive. A dash or a dot always continues a
// coordinate; a space continues it only while the coordinate is still shorter
// than the source's depth. That keeps "ШБ 6.1 48" whole — two levels of three,
// so the 48 belongs — while "БГ 18.59 23.07.2021" stops at the verse and leaves
// the date alone.
//
// The separator is one character, never two. "Бхагавад Гита 10.36 - 10.09.2020"
// writes " - " between the verse and the date, and a rule that accepted it
// would read the date as part of the coordinate.
func coordinate(s string, depth int) (parts []string, width int) {
	i := skipGlue(s, 0)
	for {
		// A word like "Песнь" or "Mantra" names the level that follows it; a
		// word like "Лекция" names a number that is not a level at all. Both
		// have to be known: the first because "ШБ Песнь 1 глава 10" is a
		// coordinate written in words, the second because "Шри Ишопанишад.
		// Лекция 5. Мантра 4" cites mantra 4, not lecture 5.
		if w, kind, ok := levelWord(s[i:]); ok {
			j := skipGlue(s, i+w)
			if n, nw := number(s[j:]); nw > 0 {
				if kind == levelOrdinal {
					k := skipGlue(s, j+nw)
					// The scan carries on past a lecture number, but not into
					// the next book: "Шри Ишопанишад. Лекция 19. ШБ 8.1.15"
					// cites SB, and that citation belongs to SB's own reading.
					if startsWithName(s[k:]) {
						break
					}
					i = k
					continue
				}
				parts = append(parts, n)
				i, width = j+nw, j+nw
				next, ok := continues(s, i, len(parts), depth, parts[len(parts)-1])
				if !ok {
					break
				}
				i = next
				continue
			}
		}
		n, nw := number(s[i:])
		if nw == 0 {
			break
		}
		parts = append(parts, n)
		i, width = i+nw, i+nw
		next, ok := continues(s, i, len(parts), depth, parts[len(parts)-1])
		if !ok {
			break
		}
		i = next
	}
	if len(parts) == 0 {
		return nil, 0
	}
	// A coordinate that ends the line by running into a four-digit year was
	// never a coordinate: "Шримад Бхагаватам - 06.08.2022" is a date. The year
	// has to end the line, or "CC_Madhya_Lila_04-198-2020_-_Jay_Krishna" loses
	// a real reference to a number that only looks like a year.
	if reTrailingYear.MatchString(s[width:]) {
		return nil, 0
	}
	return parts, width
}

// continues reports where the coordinate carries on, if it does.
func continues(s string, i, have, depth int, last string) (int, bool) {
	if i >= len(s) {
		return 0, false
	}
	// An explicit level word carries on regardless of depth: "Книга 7. Глава 7"
	// says outright which levels these are.
	j := skipGlue(s, i)
	if w, kind, ok := levelWord(s[j:]); ok && kind == levelPart {
		if k := skipGlue(s, j+w); k < len(s) {
			if _, nw := number(s[k:]); nw > 0 {
				return j, true
			}
		}
	}
	// A word can join two verses into a range: this archive writes both
	// "SB_01-13-44_to_51" and "SB_01-13-34_and_35".
	if w := rangeWord(s[i:]); w > 0 {
		if _, nw := number(s[i+w:]); nw > 0 {
			return i + w, true
		}
	}
	// A complete coordinate can still be extended by a second verse written
	// after an underscore, which is how this archive writes "SB_02-09-35_36".
	// Only upwards: "SB_09-07-21_09-08-11" writes a second whole coordinate
	// after the first, and 09 is not a verse after 21.
	if have >= depth && s[i] == '_' {
		if n, nw := number(s[i+1:]); nw > 0 && greater(n, last) {
			return i + 1, true
		}
	}
	switch s[i] {
	case '-', '.':
	case ' ', '_':
		// A space and an underscore separate the levels of a coordinate and
		// also separate a coordinate from whatever stands after it. Depth is
		// what tells them apart: "SB_10_05-26" is a canto short of complete, so
		// the underscore is still inside the coordinate, while
		// "SB_02-09-35_36_-_Oneness" is complete and the underscore is not.
		if have >= depth {
			return 0, false
		}
	default:
		return 0, false
	}
	if _, nw := number(s[i+1:]); nw == 0 {
		return 0, false
	}
	return i + 1, true
}

// greater compares two coordinate levels as the numbers they are.
func greater(a, b string) bool {
	if len(a) != len(b) {
		return len(a) > len(b)
	}
	return a > b
}

// rangeWord reads a word that joins two ends of a range, and reports how much
// of the text it and its surrounding spacing took.
func rangeWord(s string) int {
	m := reRangeWord.FindStringSubmatchIndex(s)
	if m == nil {
		return 0
	}
	return m[1]
}

var reRangeWord = regexp.MustCompile(`(?i)^[\s_.-]*(?:to|and|и|по)[\s_.-]*`)

// coordinateTokens writes the numbers the way a reference is written. Anything
// past the source's depth is a range: "13-148-150" in a source two levels deep
// is chapter 13, verses 148 to 150.
func coordinateTokens(parts []string, depth int) string {
	if len(parts) <= depth {
		return strings.Join(parts, ".")
	}
	tail := parts[depth-1:]
	span := tail[0] + "-" + tail[len(tail)-1]
	// A flat text has no level above the verse, so the range is the whole
	// coordinate rather than something hung off a chapter.
	if depth == 1 {
		return span
	}
	return strings.Join(parts[:depth-1], ".") + "." + span
}

// number reads one coordinate level. Three digits is the most any of them has,
// and a fourth means this is a year rather than a verse.
func number(s string) (string, int) {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	if n == 0 || n > 3 {
		return "", 0
	}
	return stripLeadingZeros(s[:n]), n
}

func skipGlue(s string, i int) int {
	for i < len(s) && strings.IndexByte(" .,:;_-", s[i]) >= 0 {
		i++
	}
	return i
}

type levelKind int

const (
	levelPart levelKind = iota
	levelOrdinal
)

// levelWords name a level of a coordinate: the number after them is a canto, a
// chapter or a verse.
//
// "Глава" appears here twice. Fifteen audioveda titles write it with a Latin a,
// and a homoglyph nobody can see is still a word the reader has to know.
var levelWords = []string{
	"песнь", "песни", "книга", "книге",
	"глава", "главы", "главе", "глaва",
	"гл", "chapter", "chap", "ch",
	"стих", "стихи", "текст", "тексты", "text", "texts", "verse", "verses",
	"шлока", "шлоки", "мантра", "мантре", "mantra", "кханда", "kanda",
}

// ordinalWords name a number that is not part of a coordinate. Their number is
// passed over and the reading carries on.
var ordinalWords = []string{
	"лекция", "лекции", "часть", "беседа", "выпуск", "семинар",
	"lecture", "part", "class", "session", "day",
}

// Deliberately absent: "Lila", because every level-role occurrence of it is
// inside "CC Madhya Lila", which the canon already carries as a spelling; and
// "Canto" and "Song", which occur in the corpus and are never once followed by
// a number.

var reLevelWord = wordAlternation(append(append([]string{}, levelWords...), ordinalWords...))

var ordinalWordSet = func() map[string]bool {
	set := map[string]bool{}
	for _, w := range ordinalWords {
		set[w] = true
	}
	return set
}()

// levelWord reads a level word off the front of s. The boundary after it is
// matched but not consumed: "Глава6" must leave the 6 to be read as a number.
func levelWord(s string) (width int, kind levelKind, ok bool) {
	m := reLevelWord.FindStringSubmatchIndex(s)
	if m == nil {
		return 0, 0, false
	}
	width = m[3]
	word := strings.ToLower(strings.TrimRight(s[:width], "."))
	if ordinalWordSet[word] {
		return width, levelOrdinal, true
	}
	return width, levelPart, true
}

var reTrailingYear = regexp.MustCompile(`^[.\-/]\d{4}\s*[.,]?\s*$`)

// nameRe matches any spelling of any source. The alternatives are sorted
// longest first because Go's regexp is leftmost-first, not leftmost-longest:
// unsorted, "CC Adi" matches inside "CC Adi Lila" and the reference is lost at
// the word Lila.
//
// The boundary is [^\p{L}] rather than \b. \b is ASCII in Go, so it never fires
// after a Cyrillic letter and every Russian title would silently match nothing.
// A digit is not a letter, which is wanted: "ШБ7.15" is a citation.
var nameRe = regexp.MustCompile(`(?i)(?:^|[^\p{L}])(` + namePatterns() + `)`)

// nameHere is the same alternation anchored, for asking whether a source is
// named at exactly this point.
var nameHere = regexp.MustCompile(`(?i)^(?:` + namePatterns() + `)`)

func startsWithName(s string) bool { return nameHere.MatchString(s) }

func namePatterns() string {
	var names []string
	for _, s := range sources {
		names = append(names, s.Names...)
	}
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = spellingPattern(n)
	}
	return strings.Join(parts, "|")
}

// sourceByName resolves a matched spelling back to its source.
var sourceByName = func() map[string]Source {
	out := map[string]Source{}
	for _, s := range sources {
		for _, n := range s.Names {
			out[foldName(n)] = s
		}
	}
	return out
}()

// spellingPattern lets one spelling stand for every way the space between its
// words is written. "Бхагавад-гита", "Бхагавад гита" and "Бхагавад - гита" are
// the same name, so the canon carries one entry rather than three.
func spellingPattern(name string) string {
	var b strings.Builder
	for _, part := range splitOnSpacing(name) {
		if b.Len() > 0 {
			b.WriteString(`[\s\-–—_]*`)
		}
		b.WriteString(regexp.QuoteMeta(part))
	}
	return b.String()
}

// foldName is how two spellings of one name are recognised as one: case and
// every kind of spacing removed.
func foldName(s string) string {
	return strings.ToLower(strings.Join(splitOnSpacing(s), ""))
}

func splitOnSpacing(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '-' || r == '_' || r == '–' || r == '—'
	})
}

// wordAlternation builds a pattern matching any of the words at the front of a
// string, longest first, followed by a boundary it does not consume.
func wordAlternation(words []string) *regexp.Regexp {
	sorted := append([]string(nil), words...)
	sort.Slice(sorted, func(i, j int) bool { return len(sorted[i]) > len(sorted[j]) })
	parts := make([]string, len(sorted))
	for i, w := range sorted {
		parts[i] = regexp.QuoteMeta(w)
	}
	return regexp.MustCompile(`(?i)^((?:` + strings.Join(parts, "|") + `)\.?)(?:$|[^\p{L}])`)
}
