package domain

import (
	"regexp"
	"strings"
)

// How a name is written, and who it belongs to, are different questions.
//
// An archive writes one speaker as "Radhanath Swami", "Radhanath Sw",
// "Radhanath Maharaja" and "HH Radhanath Swami" — and its neighbour writes the
// same person differently again. Name answers the first question and Key the
// second, from one vocabulary, so that a display name and an identity cannot
// disagree about what a form of address is.
//
// This is knowledge about the corpus rather than about any site: the forms are
// Vaishnava, not archival. Where a name sits on a page is a source's business
// and belongs in its script.

// honorifics precede a name and are never part of it.
//
// Both alphabets, because one speaker is written in both: a Russian archive
// files them in Cyrillic and an English one in Latin, and they are one person.
var honorifics = []string{
	"His Holiness", "His Grace", "Her Grace",
	"Srila", "Sriman", "Srimati", "Sripad", "Sri", "Shri", "Dr",
	"Его Святейшество", "Его Милость", "Её Милость", "Ее Милость",
	"Шрила", "Шриман", "Шримати", "Шрипад", "Шри",
}

// initials are the same honorifics written as letters, with or without the
// stops and spaces an archive happens to use: HH, H.H., "H G".
var reInitials = regexp.MustCompile(`(?i)^\s*(?:h\s*\.?\s*[gh]|е\s*\.?\s*[смc])\s*\.?[\s_]+`)

// dropped follows a name and is how one addresses a person rather than how one
// names them.
var dropped = []string{
	"Prabhuji", "Prabhu", "Prabh", "Pr", "P",
	"Прабхуджи", "Прабху", "Прабх", "пр",
}

// canonical is the part of a name that stays, with every spelling the archives
// use for it mapped to the one we write. "Sw" and "Maharaja" are a Swami; "dd"
// and "Mataji" are a Devi Dasi.
var canonical = map[string][]string{
	"Swami": {
		"Swami", "Swamiji", "Sw", "Maharaja", "Maharaj", "Mharaj",
		"Свами Махарадж", "Свами Махараджа", "Свами", "Махарадж", "Махараджа",
	},
	"Goswami": {
		"Goswami", "Gosvami", "Gsw",
		"Госвами Махарадж", "Госвами Махараджа", "Госвами", "Госвамй",
	},
	"Das": {"Das", "Dasa", "Ds", "дас", "даса", "дасу"},
	// Devi on its own is the same marker: "Mahamaya Devi" is a woman, and must
	// meet "Mahamaya Devi Dasi".
	"Devi Dasi": {
		"Devi Dasi", "Devi Dasa", "Devi", "Dasi", "dd", "Mataji", "Mtj",
		"деви даси", "деви даса", "деви", "даси", "матаджи", "д.д.", "дд",
	},
}

// feminine marks a woman. It is the one thing in a form of address that
// distinguishes rather than decorates, so Key keeps it: without it "Govinda
// Prabhu" and "Govinda Dasi Mataji" fold together, and they are two people.
var feminine = map[string]bool{"Devi Dasi": true}

var (
	reHonorific = alternation(honorifics, `^\s*(%s)\s*\.?[\s_]+`)
	reDropTail  = alternation(dropped, `[\s_,.]+(%s)\s*\.?\s*$`)
	reCanonTail = alternation(canonKeys(), `[\s_,.]+(%s)\s*\.?\s*$`)
	// Cyrillic is a letter here too. It was not, and the whole of a Russian
	// name fell through the filter: Key came back empty, an empty key resolves
	// to nobody, and five thousand recordings that name their speaker were
	// attached to no speaker at all.
	reNonLetters = regexp.MustCompile(`[^a-zа-яё0-9]+`)
)

// canonToFull resolves any spelling to the one we keep.
var canonToFull = func() map[string]string {
	out := map[string]string{}
	for full, variants := range canonical {
		for _, v := range variants {
			out[strings.ToLower(v)] = full
		}
	}
	return out
}()

func canonKeys() []string {
	var all []string
	for _, variants := range canonical {
		all = append(all, variants...)
	}
	return all
}

// alternation builds one pattern from a vocabulary, longest first so a longer
// phrase is never matched piecemeal by a shorter one inside it.
func alternation(words []string, format string) *regexp.Regexp {
	sorted := append([]string(nil), words...)
	for i := range sorted {
		for j := i + 1; j < len(sorted); j++ {
			if len(sorted[j]) > len(sorted[i]) {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	parts := make([]string, len(sorted))
	for i, w := range sorted {
		parts[i] = strings.ReplaceAll(regexp.QuoteMeta(w), `\ `, `[\s_-]+`)
	}
	return regexp.MustCompile(`(?i)` + strings.Replace(format, "%s", strings.Join(parts, "|"), 1))
}

// Name is how a speaker is written: the person, without the words used to
// address them, and with the words that stay spelled one way.
//
// It is not a canonical name invented here. Whatever the archive called them is
// what remains; only the forms of address are settled.
func Name(raw string) string {
	s := strings.Join(strings.Fields(strings.ReplaceAll(raw, "_", " ")), " ")
	for {
		trimmed := reInitials.ReplaceAllString(reHonorific.ReplaceAllString(s, ""), "")
		if trimmed == s {
			break
		}
		s = trimmed
	}
	for {
		trimmed := strings.TrimSpace(reDropTail.ReplaceAllString(s, ""))
		if trimmed == s {
			break
		}
		s = trimmed
	}
	// Every trailing marker comes off, not just the outermost. "Radhanath Swami
	// Maharaja" is two ways of saying the same thing and used to become
	// "Radhanath Swami Swami": the first was replaced by its canonical form and
	// appended to the second, which was still there.
	//
	// The one put back is the outermost, and a feminine marker anywhere wins:
	// it is the only part of a form of address that distinguishes rather than
	// decorates.
	var mark string
	for {
		m := reCanonTail.FindStringSubmatch(s)
		if m == nil {
			break
		}
		full := canonToFull[strings.ToLower(strings.Join(strings.Fields(m[1]), " "))]
		if mark == "" || feminine[full] {
			mark = full
		}
		s = strings.TrimSpace(s[:len(s)-len(m[0])])
	}
	if mark != "" {
		// In the alphabet the name is written in. "Бхакти Викаша Swami" is
		// nobody's name; the form of address belongs to the language that was
		// addressing them.
		if isCyrillic(s) {
			if ru, ok := canonInCyrillic[mark]; ok {
				mark = ru
			}
		}
		s = strings.TrimSpace(s + " " + mark)
	}
	return strings.TrimSpace(s)
}

// canonInCyrillic is how each marker is written when the name is.
var canonInCyrillic = map[string]string{
	"Swami":     "Свами",
	"Goswami":   "Госвами",
	"Das":       "дас",
	"Devi Dasi": "деви даси",
}

func isCyrillic(s string) bool {
	for _, r := range s {
		if r >= 0x0400 && r <= 0x04ff {
			return true
		}
	}
	return false
}

// Key is who a name belongs to: every form of address folded away, so that four
// spellings of one speaker meet.
//
// It is deliberately coarser than the name. It cannot tell a hypothetical
// "Govinda Swami" from "Govinda Prabhu" — but the names themselves still can,
// and a search that finds both is a better failure than one that finds half of
// one.
func Key(raw string) string {
	s := Name(raw)
	female := false
	for {
		m := reCanonTail.FindStringSubmatch(s)
		if m == nil {
			break
		}
		if feminine[canonToFull[strings.ToLower(strings.Join(strings.Fields(m[1]), " "))]] {
			female = true
		}
		s = strings.TrimSpace(s[:len(s)-len(m[0])])
	}
	s = strings.TrimSpace(reNonLetters.ReplaceAllString(strings.ToLower(s), " "))
	if s == "" {
		return ""
	}
	if female {
		s += " dasi"
	}
	return s
}

// cyrillic is the same name written in the other alphabet. A Russian archive
// files a speaker in Cyrillic and an English one in Latin, and Fold has to see
// one person: "Локанатха" and "Lokanatha", "Радханатх" and "Radhanath".
//
// Sound, not spelling — this feeds the same folding as the Latin rules below,
// so ч becomes ch and then c, and the two routes end up in the same place.
var cyrillic = strings.NewReplacer(
	"а", "a", "б", "b", "в", "v", "г", "g", "д", "d", "е", "e", "ё", "e",
	"ж", "j", "з", "z", "и", "i", "й", "i", "к", "k", "л", "l", "м", "m",
	"н", "n", "о", "o", "п", "p", "р", "r", "с", "s", "т", "t", "у", "u",
	"ф", "f", "х", "h", "ц", "c", "ч", "ch", "ш", "sh", "щ", "sh",
	"ъ", "", "ы", "i", "ь", "", "э", "e", "ю", "yu", "я", "ya",
)

// transliteration is where romanisations of the same sound differ: ch for c,
// sh for s, ri for r, a trailing -a that comes and goes. Folding them lets
// "Chandramouli" meet "Candramauli".
var transliteration = []struct {
	from *regexp.Regexp
	to   string
}{
	{regexp.MustCompile(`ch`), "c"},
	{regexp.MustCompile(`sh`), "s"},
	{regexp.MustCompile(`ri|ree|rea`), "r"},
	{regexp.MustCompile(`aa|ee|ii|oo|uu|ou|au|w`), "a"},
	{regexp.MustCompile(`a(\s|$)`), "$1"},
}

// Fold reduces a Key further, to the sound rather than the spelling, so that
// romanisations of one name meet. It is coarser again than Key and is meant for
// proposing that two people are one, not for asserting it.
func Fold(key string) string {
	s := cyrillic.Replace(key)
	for _, r := range transliteration {
		s = r.from.ReplaceAllString(s, r.to)
	}
	return strings.TrimSpace(strings.Join(strings.Fields(collapseDoubles(s)), " "))
}

// collapseDoubles reduces a doubled consonant to one — "Vallabha" against
// "Valabha". Go's regexp has no backreference, so this is a pass rather than a
// pattern.
func collapseDoubles(s string) string {
	const doubled = "bcdfgjklmnpqrstvxz"
	var b strings.Builder
	b.Grow(len(s))
	var prev rune
	for _, r := range s {
		if r == prev && strings.ContainsRune(doubled, r) {
			continue
		}
		b.WriteRune(r)
		prev = r
	}
	return b.String()
}

// organisations run in front of a place name without being part of it: an
// archive writes "ISKCON Chennai" where the place is Chennai, the same way it
// writes "HG Radha Gopinath Prabhu" where the person is Radha Gopinath.
var organisations = []string{
	"ISKCON", "ISCKON", "Iskcon",
	"Hare Krishna Temple", "Hare Krishna Centre", "Hare Krishna Center",
	"Sri Sri Radha", "Radha Krishna Temple", "Temple of",
}

var reOrganisation = alternation(organisations, `^\s*(%s)[\s_,-]+`)

// Place is where a recording was made, without the organisation that ran the
// hall. Every temple the movement has cannot be listed, and a search for a city
// should not depend on which of them wrote its own name first.
//
// A name that is nothing but the organisation is not a place: "ISKCON" on its
// own says no more than "somewhere".
func Place(raw string) string {
	s := strings.Join(strings.Fields(strings.ReplaceAll(raw, "_", " ")), " ")
	for {
		trimmed := strings.TrimSpace(reOrganisation.ReplaceAllString(s, ""))
		if trimmed == s {
			break
		}
		s = trimmed
	}
	for _, org := range organisations {
		if strings.EqualFold(s, org) {
			return ""
		}
	}
	return s
}
