package domain_test

import (
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// Every line here was taken from a recording we hold. A rule that works on
// invented examples and not on these is a rule that does nothing.
func TestRefsReadsRealTitles(t *testing.T) {
	cases := []struct {
		title string
		want  string
	}{
		// The ordinary shape, on the two archives that carry most of them.
		{"Нимай Сундара дас - Шримад Бхагаватам 3.24.45. - 24.08.2021.", "SB 3.24.45"},
		{"Джива-раджа дас - Шримад Бхагаватам 4.12.25. - 03.06.2024.", "SB 4.12.25"},
		{"ШБ 5.14.46 - Материальный мир как огромный лес наслаждений", "SB 5.14.46"},
		{"Парататтва дас - Бхагавад-Гита 2.1. - 16.09.2021.", "BG 2.1"},

		// A range.
		{"Упендра дас - Шримад Бхагаватам 4.7.56-57. - 30.08.2023.", "SB 4.7.56-57"},
		{"Кришна Чаран дас - Бхагавад-Гита 8.18-19. -  26.09.2022.", "BG 8.18-19"},
		{"ШБ 6.12.2-7 - Славная смерть Вритрасуры", "SB 6.12.2-7"},

		// A space continues the coordinate while it is shorter than the depth.
		{"Е.М. Сарвагья прабху. ШБ 8.15 18-28. Могущество служения гуру. 4.06.2024 Минск", "SB 8.15.18-28"},
		{"ШБ7.15 43-45. Заточить меч", "SB 7.15.43-45"},

		// And stops once it is not, so the date beside it stays a date.
		{"Канай Тхакур дас - Бхагавад Гита 10.36 - 10.09.2020", "BG 10.36"},
		{"Бхагавад Гита 18.59 23.07.2021", "BG 18.59"},
		{"Е.М. Сарвагья прабху. ШБ 9.10.12. Уроки Рама-лилы - 3. 4.01.2025. Хампи", "SB 9.10.12"},

		// The archive that writes its levels with dashes, and pads them.
		{"CC Madhya Lila 13-148-150", "CC_MADHYA 13.148-150"},
		{"SB 01-13-15 4.6 MB · MP3", "SB 1.13.15"},

		// A coordinate written in words.
		{"Шримад Бхагаватам. Книга 5. Глава 6.", "SB 5.6"},
		{"ШБ Песнь 1 глава 10", "SB 1.10"},
		{"Бхагавад-гита. Глава 6. Дхьяна-йога", "BG 6"},
		{"Bramha Samhita Text 33", "BS 33"},

		// A lecture number is not a coordinate, and the reading carries on past
		// it to the one that is.
		{"Шри Ишопанишад. Лекция 5. Мантра 4.", "ISO 4"},

		// Spellings the corpus does not publish and the archives do.
		{"Bhagvad Gita 09 24", "BG 9.24"},
		{"Srimad Bhagavatam 1.2.10", "SB 1.2.10"},
		{"Наставления Кришны Бхагавад-гиты 8 глава", "BG 8"},

		// A title that is nothing but the reference. It reads exactly like a
		// date and must not be taken for one.
		{"ШБ 1.2.10", "SB 1.2.10"},
		// A flat text has no chapter to hang a range from.
		{"Нектар наставлений 2-5", "NOI 2-5"},
		// A second verse written after the coordinate is complete extends it,
		// but only upwards.
		{"2010-09-21_SB_02-09-35_36_-_Oneness_And_difference.mp3", "SB 2.9.35-36"},
		{"2017-07-17_SB_09-07-21_09-08-11_-_Subala_Pr.mp3", "SB 9.7.21"},
		// A number that only looks like a year, in the middle of a filename.
		{"2020-07-26_CC_Madhya_Lila_04-198-2020_-_Jay_Krishna_Pr.mp3", "CC_MADHYA 4.198"},
	}

	for _, c := range cases {
		refs := domain.Refs(c.title)
		if got := label(refs); got != c.want {
			t.Errorf("%q\n got %q\nwant %q", c.title, got, c.want)
		}
	}
}

// A title that names a scripture without citing it is a title. Reading a
// reference out of it invents a citation nobody made.
func TestRefsRefusesWhatIsNotACitation(t *testing.T) {
	for _, title := range []string{
		// Named, discussed, not cited.
		"Glories of Srimad Bhagavatam",
		"Introduction to Bhagavad Gita",
		// A date is not a coordinate, however close it stands.
		"Е.М. Чайтанья Чандра Чаран пр. - Шримад Бхагаватам - 06.08.2022",
		"Ачьютатма дас - Чайтанья-Чаритамрита - 2020.04.25",
		// A place whose name begins with a scripture's.
		"Вебинар для Гита-нагари. 15.01.2022",
		// An episode number, which is why # is not a separator.
		"Нектар преданности #17. 2022.09.15",
		// A person, not a book.
		"Chaitanya Charan Pr - The Deer like life",
	} {
		if refs := domain.Refs(title); len(refs) != 0 {
			t.Errorf("%q invented %q", title, label(refs))
		}
	}
}

// A line names one scripture once. Every second coordinate for a scripture
// already cited turned out, on the corpus we hold, to be the date the talk was
// given — which is written exactly where a coordinate would be.
func TestOneScriptureIsCitedOnce(t *testing.T) {
	for _, c := range []struct{ title, want string }{
		{"ШБ 5.9.15. Шок-контент Шримад-бхагаватам. 25.10.2023", "SB 5.9.15"},
		{"ШБ 1.3.43. Мистика Бхагаватам. 1.05.26. Продолжение", "SB 1.3.43"},
		{"ШБ 1.2.17. Милость Кришны через Шримад-бхагаватам. 28.04.25", "SB 1.2.17"},
		{"ШБ 3.3.10. Духовное сияние Бхагавад-гиты. 10.03.2026", "SB 3.3.10"},
	} {
		if got := label(domain.Refs(c.title)); got != c.want {
			t.Errorf("%q\n got %q\nwant %q", c.title, got, c.want)
		}
	}
}

// The second naming carries the coordinate more often than the first does, so
// every occurrence is looked at rather than the first.
func TestRefsReadsEveryOccurrence(t *testing.T) {
	const title = "Лекции по Шримад Бхагаватам | ШБ 4.29.64 - Беседы Нарады"
	if got := label(domain.Refs(title)); got != "SB 4.29.64" {
		t.Errorf("= %q, want SB 4.29.64", got)
	}
}

// A lecture number is passed over, but the pass stops at the next scripture:
// that coordinate belongs to it, not to the one before.
func TestALectureNumberDoesNotReachIntoTheNextScripture(t *testing.T) {
	const title = "Шри Ишопанишад. Лекция 19. ШБ 8.1.15."
	if got := label(domain.Refs(title)); got != "SB 8.1.15" {
		t.Errorf("= %q, want SB 8.1.15 alone", got)
	}
}

// Cites says where it read, so a caller taking a title apart can cut the
// citation out and keep what is left.
func TestCitesSaysWhereItRead(t *testing.T) {
	const title = "Эката дас - Шримад Бхагаватам 4.1.9-15. - 16.11.2022."
	cites := domain.Cites(title)
	if len(cites) != 1 {
		t.Fatalf("cites = %d", len(cites))
	}
	c := cites[0]
	if got := title[c.Start:c.End]; got != "Шримад Бхагаватам 4.1.9-15" {
		t.Errorf("read %q", got)
	}
	rest := strings.TrimSpace(title[:c.Start] + title[c.End:])
	if strings.Contains(rest, "Бхагаватам") {
		t.Errorf("rest still names the scripture: %q", rest)
	}
}

// The canon is what a reference folds to, so every spelling of one scripture
// has to arrive at one code.
func TestEverySpellingFoldsToOneCode(t *testing.T) {
	for _, title := range []string{
		"Шримад Бхагаватам 1.2.10",
		"Шримад-Бхагаватам 1.2.10",
		"Бхагаватам 1.2.10",
		"ШБ 1.2.10",
		"SB 1.2.10",
		"Srimad-Bhagavatam 1.2.10",
	} {
		if got := label(domain.Refs(title)); got != "SB 1.2.10" {
			t.Errorf("%q -> %q", title, got)
		}
	}
}

// The canon has to be usable: one code each, a readable depth, and at least one
// spelling, or nothing in a title can find it.
func TestTheCanonIsUsable(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range domain.Sources() {
		if seen[s.Code] {
			t.Errorf("%s is listed twice", s.Code)
		}
		seen[s.Code] = true
		if s.Depth() < 1 || s.Depth() > 3 {
			t.Errorf("%s: token scheme %q reads as depth %d", s.Code, s.TokenScheme, s.Depth())
		}
		if len(s.Names) == 0 {
			t.Errorf("%s has no spelling, so nothing in a title can find it", s.Code)
		}
	}
}

func label(refs []domain.Ref) string {
	parts := make([]string, len(refs))
	for i, r := range refs {
		parts[i] = r.Label()
	}
	return strings.Join(parts, ", ")
}

// A book is picked from a list on a screen, and that list comes from the corpus
// dictionary, which writes Śrīmad-Bhāgavatam and Śrī Īśopaniṣad. Not one
// recording in the archive is written that way, so without folding the marks
// off, picking a book by the name shown finds nothing.
func TestAScriptureIsKnownByItsMarkedSpellingToo(t *testing.T) {
	for _, c := range []struct{ name, code string }{
		{"Śrīmad-Bhāgavatam", "SB"},
		{"Śrī Īśopaniṣad", "ISO"},
		{"Bhagavad-gītā", "BG"},
		{"Brahma-saṁhitā", "BS"},
		{"Caitanya-caritāmṛta Madhya-līlā", "CC_MADHYA"},
		{"Nārada-bhakti-sūtra", "NBS"},
		{"Kṛṣṇa Book", "KB"},
		// And the plain spellings still are.
		{"Шримад-Бхагаватам", "SB"},
		{"Srimad Bhagavatam", "SB"},
		{"БГ", "BG"},
	} {
		src, ok := domain.SourceByName(c.name)
		if !ok || src.Code != c.code {
			t.Errorf("%q -> %q (found=%v), want %s", c.name, src.Code, ok, c.code)
		}
	}
	if _, ok := domain.SourceByName("Коран"); ok {
		t.Error("a book the corpus does not hold was recognised")
	}
}
