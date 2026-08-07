package domain_test

import (
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// A channel name is not a speaker. A temple's channel carries forty people, and
// even one teacher's own carries guests — so who is speaking has to come from
// the title, where whoever uploaded it wrote the name, in the forms this corpus
// writes names in.
//
// Every line here is a real title from a channel being indexed. The marker is
// written the way the language writes it — "дас" in Russian is lower case.
func TestTheSpeakerIsReadOutOfTheTitle(t *testing.T) {
	for title, want := range map[string]string{
		"Е.М. Сарвагья прабху. ШБ 6.16.44. Кришна как источник всего":              "Сарвагья",
		"Бхакти Центр | Е.М. Павана дас | Как сохранить Шрилу Прабхупаду? | 08.07": "Павана дас",
		"Сознание преданного. ШБ 1.6.4 Лектор: Е.М. Нитай Мангала прабху":          "Нитай Мангала",
		"Могущество времени. ШБ 1.9.14. Лектор: Е.М. Ачьюта дас. 2026.07.15":       "Ачьюта дас",
		"Анагха дас - Шримад Бхагаватам 4.5.13-21. - 19.04.2023.":                  "Анагха дас",
		"Джапа - 13 Декабря 2020 Е.С.Локанатх Свами":                               "Локанатх Свами",
		"The Only Way To Truly Know Krishna | SB 2.9.1 | Tokyo | Srila Prabhupada": "Prabhupada",
		"Chaitanya-charitamrita, Adi-lila 9.42 | Ananda Vardhana Swami — 07/26":    "Ananda Vardhana Swami",
	} {
		if got := domain.Speaker(title); got != want {
			t.Errorf("Speaker(%q)\n = %q\nwant %q", title, got, want)
		}
	}
}

// The case that makes this worth doing: a guest on somebody else's channel is
// attributed to the guest.
func TestAGuestOnAChannelIsTheGuest(t *testing.T) {
	for _, c := range [][2]string{
		{"Е С  Шиварама Свами ванапрастха в 50", "Шиварама Свами"},
		{"H H  Niranjana Swami  Mayapur  About Vanaprastha  April 8  2022", "Niranjana Swami"},
	} {
		if got := domain.Speaker(c[0]); got != c[1] {
			t.Errorf("Speaker(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}

// A title that names nobody yields nobody. Inventing a speaker here is worse
// than leaving the question to the source's own setting or to the model.
func TestATitleNamingNobodyYieldsNobody(t *testing.T) {
	for _, title := range []string{
		"2012. Вриндаван парикрама. Сантанукунд.",
		"Transcendental Madness | CC Adi Lila 7.7",
		"Вечные знания для современной женщины. Встреча всей школы.",
		"Мантра Йога",
		"",
		"ШБ 1.9.14",
	} {
		if got := domain.Speaker(title); got != "" {
			t.Errorf("Speaker(%q) = %q, want nobody", title, got)
		}
	}
}

// What the archive states outright beats what is inferred from a form of
// address, because the archive is the one that knows.
func TestAStatedLecturerWins(t *testing.T) {
	got := domain.Speaker("Шримад Бхагаватам с Прабхупада дасом. Лектор: Ачьюта дас")
	if got != "Ачьюта дас" {
		t.Errorf("= %q", got)
	}
}
