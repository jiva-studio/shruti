package canonical

import (
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

type expRef struct{ source, tokens string }

func TestParse(t *testing.T) {
	type expect struct {
		ok       bool
		date     string // "" means nil
		lang     string
		author   string
		location string
		title    string
		fallback bool
		kind     string
		refs     []expRef
	}

	cases := []struct {
		name string
		path string
		want expect
	}{
		// --- ru lectures with verse ---
		{
			name: "ru/BG with verse and title",
			path: "/lake/outbox/sorted/ru/1973-08-08/БГ 02.08 — Лондон — Кришна вне наших чувств [a1b2c3].mp3",
			want: expect{
				ok: true, date: "1973-08-08", lang: "ru", author: authorRu,
				location: "Лондон", title: "Кришна вне наших чувств",
				refs: []expRef{{"BG", "2.8"}},
			},
		},
		{
			name: "ru/SB three-part verse",
			path: "/x/outbox/sorted/ru/1974-04-08/ШБ 01.08.41 — Майапур — Молитвы Кунти [123abc].mp3",
			want: expect{
				ok: true, date: "1974-04-08", lang: "ru", author: authorRu,
				location: "Майапур", title: "Молитвы Кунти",
				refs: []expRef{{"SB", "1.8.41"}},
			},
		},
		{
			name: "ru/CC-Adi",
			path: "/x/outbox/sorted/ru/1974-03-04/ЧЧ-Ади 07.04 — Майапур — Повторение текста [384a92].mp3",
			want: expect{
				ok: true, date: "1974-03-04", lang: "ru", author: authorRu,
				location: "Майапур", title: "Повторение текста",
				refs: []expRef{{"CC_ADI", "7.4"}},
			},
		},
		{
			name: "ru/CC-Madhya without title",
			path: "/x/outbox/sorted/ru/1973-12-08/ЧЧ-Мадхйа 20.108 — Бомбей [aabbcc].mp3",
			want: expect{
				ok: true, date: "1973-12-08", lang: "ru", author: authorRu,
				location: "Бомбей", title: "", fallback: true,
				refs: []expRef{{"CC_MADHYA", "20.108"}},
			},
		},
		{
			name: "ru/CC-Antya",
			path: "/x/outbox/sorted/ru/1976-05-15/ЧЧ-Антйа 04.176 — Хайдарабад — Lecture [aaa111].mp3",
			want: expect{
				ok: true, date: "1976-05-15", lang: "ru", author: authorRu,
				location: "Хайдарабад", title: "Lecture",
				refs: []expRef{{"CC_ANTYA", "4.176"}},
			},
		},
		{
			name: "ru/verse with hyphen range",
			path: "/x/outbox/sorted/ru/1969-05-09/БГ 04.01-02 — Коламбус — Б.Г. 04.01-02 [b6abd1].mp3",
			want: expect{
				ok: true, date: "1969-05-09", lang: "ru", author: authorRu,
				location: "Коламбус", title: "Б.Г. 04.01-02",
				refs: []expRef{{"BG", "4.1"}, {"BG", "4.2"}},
			},
		},
		{
			name: "ru/Ишопанишад",
			path: "/x/outbox/sorted/ru/1973-01-15/Ишопанишад 03 — Калькутта — Текст [aabb01].mp3",
			want: expect{
				ok: true, date: "1973-01-15", lang: "ru", author: authorRu,
				location: "Калькутта", title: "Текст",
				refs: []expRef{{"ISO", "3"}},
			},
		},
		{
			name: "ru/НП without title",
			path: "/x/outbox/sorted/ru/1973-01-31/НП — Калькутта — Превосходство пред. служения [53e346].mp3",
			want: expect{
				ok: true, date: "1973-01-31", lang: "ru", author: authorRu,
				location: "Калькутта", title: "Превосходство пред. служения",
				refs: []expRef{{"NOD", ""}},
			},
		},

		// --- ru with kind tag ---
		{
			name: "ru/Прогулка → morning_walk",
			path: "/x/outbox/sorted/ru/1974-04-06/[Прогулка] — Бомбей — Шакти-авеша аватары [ad2ef4].mp3",
			want: expect{
				ok: true, date: "1974-04-06", lang: "ru", author: authorRu,
				location: "Бомбей", title: "Шакти-авеша аватары", kind: "morning_walk",
			},
		},
		{
			name: "ru/Беседа → conversation",
			path: "/x/outbox/sorted/ru/1973-07-09/[Беседа] — Лондон — Нельзя купить сознание Кришны [a9a790].mp3",
			want: expect{
				ok: true, date: "1973-07-09", lang: "ru", author: authorRu,
				location: "Лондон", title: "Нельзя купить сознание Кришны", kind: "conversation",
			},
		},
		{
			name: "ru/Праздник with book+verse after tag",
			path: "/x/outbox/sorted/ru/1975-12-22/[Праздник] — БГ 16.07 — Бомбей — День ухода Бхактисиддханты [8a3168].mp3",
			want: expect{
				ok: true, date: "1975-12-22", lang: "ru", author: authorRu,
				location: "Бомбей", title: "День ухода Бхактисиддханты", kind: "festival",
				refs: []expRef{{"BG", "16.7"}},
			},
		},
		{
			name: "ru/Прочее tag",
			path: "/x/outbox/sorted/ru/1975-01-26/[Прочее] — Гонконг — Важно повторять Харе Кришна [f4822c].mp3",
			want: expect{
				ok: true, date: "1975-01-26", lang: "ru", author: authorRu,
				location: "Гонконг", title: "Важно повторять Харе Кришна", kind: "other",
			},
		},

		// --- en lectures ---
		{
			name: "en/BG with verse",
			path: "/x/outbox/sorted/en/1973-09-27/BG 13.16 — Bombay [9ebfb5].mp3",
			want: expect{
				ok: true, date: "1973-09-27", lang: "en", author: authorEn,
				location: "Bombay", title: "", fallback: true,
				refs: []expRef{{"BG", "13.16"}},
			},
		},
		{
			name: "en/SB three-part",
			path: "/x/outbox/sorted/en/1972-05-19/SB 02.03.01 — Los Angeles [46f33a].mp3",
			want: expect{
				ok: true, date: "1972-05-19", lang: "en", author: authorEn,
				location: "Los Angeles", title: "", fallback: true,
				refs: []expRef{{"SB", "2.3.1"}},
			},
		},
		{
			name: "en/CC_ADI three-part with leading zeros",
			path: "/x/outbox/sorted/en/1974-03-09/CC_ADI 07.007 — Mayapur — Ädi-lélä 7.7 [5d6637].mp3",
			want: expect{
				ok: true, date: "1974-03-09", lang: "en", author: authorEn,
				location: "Mayapur", title: "Ädi-lélä 7.7",
				refs: []expRef{{"CC_ADI", "7.7"}},
			},
		},
		{
			name: "en/BG no verse",
			path: "/x/outbox/sorted/en/1966-08-03/BG — New York [2d4fa9].mp3",
			want: expect{
				ok: true, date: "1966-08-03", lang: "en", author: authorEn,
				location: "New York", title: "", fallback: true,
				refs: []expRef{{"BG", ""}},
			},
		},
		{
			name: "en/ISO with verse",
			path: "/x/outbox/sorted/en/1970-05-16/ISO 11 — Los Angeles [998d33].mp3",
			want: expect{
				ok: true, date: "1970-05-16", lang: "en", author: authorEn,
				location: "Los Angeles", title: "", fallback: true,
				refs: []expRef{{"ISO", "11"}},
			},
		},

		// --- en walk/conv tags ---
		{
			name: "en/Walk → morning_walk",
			path: "/x/outbox/sorted/en/1975-09-15/[Walk] — Vrindavan — MW [783a52].mp3",
			want: expect{
				ok: true, date: "1975-09-15", lang: "en", author: authorEn,
				location: "Vrindavan", title: "MW", kind: "morning_walk",
			},
		},
		{
			name: "en/Conv with em-dash inside title",
			path: "/x/outbox/sorted/en/1975-05-13/[Conv] — Perth — With — Gaëeça däsa's Mother and Sister [aedcdc].mp3",
			want: expect{
				ok: true, date: "1975-05-13", lang: "en", author: authorEn,
				location: "Perth", title: "With — Gaëeça däsa's Mother and Sister", kind: "conversation",
			},
		},
		{
			name: "en/Bhajan single part = location",
			path: "/x/outbox/sorted/en/1968-12-25/[Bhajan] — Los Angeles [255c30].mp3",
			want: expect{
				ok: true, date: "1968-12-25", lang: "en", author: authorEn,
				location: "Los Angeles", title: "", fallback: true, kind: "bhajan",
			},
		},
		{
			name: "en/Address",
			path: "/x/outbox/sorted/en/1973-08-08/[Address] — Paris — AR [b3897f].mp3",
			want: expect{
				ok: true, date: "1973-08-08", lang: "en", author: authorEn,
				location: "Paris", title: "AR", kind: "address",
			},
		},

		// --- date variants ---
		{
			name: "ru/year-??-?? unknown month/day",
			path: "/x/outbox/sorted/ru/1966-??-??/[Прочее] — Нью-Йорк — Лекция [123abc].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "Нью-Йорк", title: "Лекция", kind: "other",
			},
		},
		{
			name: "ru/_no_date title-only",
			path: "/x/outbox/sorted/ru/_no_date/Karl Marx (Hayagrīva) [a01167].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "", title: "Karl Marx (Hayagrīva)",
			},
		},
		{
			name: "en/_no_date Misc tag → title",
			path: "/x/outbox/sorted/en/_no_date/[Misc] — Arthur Schopenhauer (Hayagrīva) [18a1f0].mp3",
			want: expect{
				ok: true, date: "", lang: "en", author: authorEn,
				location: "", title: "Arthur Schopenhauer (Hayagrīva)", kind: "other",
			},
		},
		{
			name: "en/_no_date Conv with multi-parts",
			path: "/x/outbox/sorted/en/_no_date/[Conv] — Misc 05 — Conversation [941fcd].mp3",
			want: expect{
				ok: true, date: "", lang: "en", author: authorEn,
				location: "Misc 05", title: "Conversation", kind: "conversation",
			},
		},

		// --- extras ---
		{
			name: "ru/extra/bhajan multi-part",
			path: "/x/outbox/sorted/ru/extra/bhajan/Атланта — Парама Каруна [7f2d34].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "Атланта", title: "Парама Каруна", kind: "bhajan",
			},
		},
		{
			name: "ru/extra/bhajan single-part = title",
			path: "/x/outbox/sorted/ru/extra/bhajan/Говинда [190383].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "", title: "Говинда", kind: "bhajan",
			},
		},
		{
			name: "ru/extra/morning_walk",
			path: "/x/outbox/sorted/ru/extra/morning_walk/Бомбей — Завистливые становятся змеями и собаками [ec9eb6].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "Бомбей", title: "Завистливые становятся змеями и собаками", kind: "morning_walk",
			},
		},
		{
			name: "ru/extra/lecture (no kind tag — fragment)",
			path: "/x/outbox/sorted/ru/extra/lecture/Лос-Анджелес — Самое удивительное [66d7f6].mp3",
			want: expect{
				ok: true, date: "", lang: "ru", author: authorRu,
				location: "Лос-Анджелес", title: "Самое удивительное",
			},
		},

		// --- collision suffix ---
		{
			name: "collision suffix -2",
			path: "/x/outbox/sorted/ru/1973-08-08/БГ 02.08 — Лондон — X [a1b2c3]-2.mp3",
			want: expect{
				ok: true, date: "1973-08-08", lang: "ru", author: authorRu,
				location: "Лондон", title: "X",
				refs: []expRef{{"BG", "2.8"}},
			},
		},

		// --- non-canonical paths ---
		{
			name: "non-canonical path",
			path: "/some/random/file.mp3",
			want: expect{ok: false},
		},
		{
			name: "outbox/duplicates excluded",
			path: "/x/outbox/duplicates/ru/1973-08-08/whatever.mp3",
			want: expect{ok: false},
		},
		{
			name: "non-mp3 extension",
			path: "/x/outbox/sorted/ru/1973-08-08/БГ 02.08 — Лондон [aabbcc].pdf",
			want: expect{ok: false},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Parse(tc.path)
			if ok != tc.want.ok {
				t.Fatalf("ok=%v want %v", ok, tc.want.ok)
			}
			if !ok {
				return
			}
			gotDate := ""
			if got.Date != nil {
				gotDate = got.Date.Format("2006-01-02")
			}
			if gotDate != tc.want.date {
				t.Errorf("date=%q want %q", gotDate, tc.want.date)
			}
			if !equalLang(got.Languages, tc.want.lang) {
				t.Errorf("languages=%v want [%s]", got.Languages, tc.want.lang)
			}
			if got.AuthorRaw != tc.want.author {
				t.Errorf("author=%q want %q", got.AuthorRaw, tc.want.author)
			}
			if got.LocationRaw != tc.want.location {
				t.Errorf("location=%q want %q", got.LocationRaw, tc.want.location)
			}
			if got.Title != tc.want.title {
				t.Errorf("title=%q want %q", got.Title, tc.want.title)
			}
			if got.TitleIsFallback != tc.want.fallback {
				t.Errorf("titleFallback=%v want %v", got.TitleIsFallback, tc.want.fallback)
			}
			if got.KindTag != tc.want.kind {
				t.Errorf("kind=%q want %q", got.KindTag, tc.want.kind)
			}
			if !equalRefs(got.References, tc.want.refs) {
				t.Errorf("refs=%v want %v", got.References, tc.want.refs)
			}
		})
	}
}

func equalLang(got []string, want string) bool {
	if want == "" {
		return len(got) == 0
	}
	return len(got) == 1 && got[0] == want
}

func equalRefs(got []track.RefRaw, want []expRef) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].SourceCode != want[i].source || got[i].Tokens != want[i].tokens {
			return false
		}
	}
	return true
}
