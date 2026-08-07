package domain

import (
	"regexp"
	"strings"
)

// Speaker finds the person named in a line of text, where one is named.
//
// An archive that files a recording under a channel says nothing about who is
// speaking on it: a temple's channel carries forty people, and even one
// teacher's own carries guests. What does say is the title, because whoever
// uploaded it wrote the speaker into it — and wrote it the way this corpus
// writes names:
//
//	Е.М. Сарвагья прабху. ШБ 6.16.44. Кришна…
//	Бхакти Центр | Е.М. Павана дас | Как сохранить… | 08.07.2026
//	Сознание преданного. ШБ 1.6.4 Лектор: Е.М. Нитай Мангала прабху
//	Анагха дас - Шримад Бхагаватам 4.5.13-21. - 19.04.2023
//	The Only Way To Truly Know Krishna | SB 2.9.1 | Tokyo | Srila Prabhupada
//
// What marks a name is a form of address, not a position: the name may open the
// title, close it, or sit in the middle. So this looks for the address and
// takes the words attached to it, rather than guessing by where it stands.
//
// Nothing is invented. A title that names nobody yields nothing, which is the
// answer that lets a source's own setting, or the model, have the question.
var (
	// address follows a name: "Сарвагья прабху", "Анагха дас", "Bhakti Vikasa
	// Swami". The words before it are the name, at most four of them — a longer
	// run is a sentence that happens to end in one.
	//
	// The address is matched without regard to case: a title writes "Свами" and
	// "Swami" as often as not, and a list of lower-case words misses every one
	// of them.
	//
	// The end of the address is spelled out rather than written \b: Go's word
	// boundary is ASCII, so it does not see one between "прабху" and the full
	// stop after it, and every Cyrillic title fell through.
	reNamedByTail = regexp.MustCompile(
		`(?:^|[|\-—–:.]\s*|\s)((?:[А-ЯЁA-Z][\p{L}'’-]*\s+){0,3}[А-ЯЁA-Z][\p{L}'’-]*)\s+` +
			`(?i:(прабхуджи|прабху|даса|дас|свами|госвами|махараджа|махарадж|матаджи|деви\s+даси|даси|` +
			`prabhuji|prabhu|dasa|das|swami|goswami|maharaja|maharaj|mataji|devi\s+dasi|dasi))(?:$|[^\p{L}])`)

	// addressFirst precedes a name and needs no tail: "Шрила Прабхупада".
	reNamedByHead = regexp.MustCompile(
		`(?:^|[|\-—–:.]\s*|\s)(?i:Шрила|Srila)\s+((?:[А-ЯЁA-Z][\p{L}'’-]*\s*){1,3})`)

	// marked is an archive saying it outright.
	reMarkedSpeaker = regexp.MustCompile(`(?i)(?:лектор|лекция|ведущий|speaker|lecturer|by)\s*[:—-]\s*(.{3,60})`)
)

func Speaker(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return ""
	}
	// What the archive states outright beats what is inferred from a form of
	// address, because the archive is the one that knows.
	if m := reMarkedSpeaker.FindStringSubmatch(text); m != nil {
		if n := speakerIn(m[1]); n != "" {
			return n
		}
	}
	return speakerIn(text)
}

func speakerIn(text string) string {
	if m := reNamedByTail.FindStringSubmatch(text); m != nil {
		if n := Name(strings.TrimSpace(m[1]) + " " + m[2]); n != "" && Key(n) != "" {
			return n
		}
	}
	if m := reNamedByHead.FindStringSubmatch(text); m != nil {
		if n := Name(strings.TrimSpace(m[1])); n != "" && Key(n) != "" {
			return n
		}
	}
	return ""
}
