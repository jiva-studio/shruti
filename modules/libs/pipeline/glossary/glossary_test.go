package glossary

import (
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Бхагавад-гита", "бхагавадгита"},
		{"Бхагават-гите", "бхагаватгите"},
		{"Bhagavad-gītā", "bhagavadgita"},
		{"Śrī Caitanya Mahāprabhu", "sricaitanyamahaprabhu"},
		{"Шри Чайтанья Махапрабху", "шричайтаньямахапрабху"},
		{"Кришна-према", "кришнапрема"},
		{"Hare Kṛṣṇa", "harekrsna"},
	}
	for _, c := range cases {
		if got := normalize(c.in); got != c.want {
			t.Errorf("normalize(%q) = %q; want %q", c.in, got, c.want)
		}
	}
}

func TestMatch_RuMangledBhagavadGita(t *testing.T) {
	g := Build(testEntries())
	// chunk text from a real failure: lite produced "Бхагават-гите"
	text := "Лекция по Бхагават-гите, глава 7, текст 4, прочитана"
	hits := g.Match(text, "ru", 0.50, 10)
	if !containsCanonical(hits, "Бхагавад-гита") {
		t.Errorf("expected Бхагавад-гита match for mangled %q, got %v", text, hits)
	}
}

func TestMatch_RuDeclension(t *testing.T) {
	g := Build(testEntries())
	text := "Бхактиведантой Свами Прабхупадой 19 февраля 1974"
	hits := g.Match(text, "ru", 0.50, 10)
	// "Прабхупадой" (instr.) should still match "Шрила Прабхупада"
	if !containsCanonical(hits, "Шрила Прабхупада") {
		t.Errorf("expected Шрила Прабхупада match in %q, got %v", text, hits)
	}
}

func TestMatch_EnIASTStripped(t *testing.T) {
	g := Build(testEntries())
	text := "From the Bhagavadgita, chapter 7, text 4..."
	hits := g.Match(text, "en", 0.50, 10)
	if !containsCanonical(hits, "Bhagavad-gītā") {
		t.Errorf("expected Bhagavad-gītā match in %q, got %v", text, hits)
	}
}

func TestMatch_NoFalsePositiveOnNoise(t *testing.T) {
	g := Build(testEntries())
	// Pure Russian noise unrelated to Vaishnava terminology.
	text := "Иногда мы потеем, выступает испарина, это вода, в Индии это особенно заметно летом."
	hits := g.Match(text, "ru", 0.50, 10)
	for _, h := range hits {
		// "Индии" can plausibly trigger something — but no canonical we
		// have should fire on this generic Russian sentence.
		// If anything fires, log and fail.
		t.Errorf("unexpected hit on noise text: %+v", h)
	}
}

func TestMatch_AliasRoutesToCanonical(t *testing.T) {
	entries := []Entry{
		{
			Canonical: map[string]string{"ru": "Маяпур"},
			Category:  "place",
			Aliases:   map[string][]string{"ru": {"Майяпур", "Майапур", "Майпур"}},
		},
	}
	g := Build(entries)
	// Each whisper-variant should hit, and the hint must surface the
	// canonical form (not the alias that scored).
	cases := []string{
		"Лекция прочитана в Майяпуре 14 марта 1976 года.",
		"Это было в Майапуре, в Индии.",
		"Прабхупада сейчас в Майпуре.",
	}
	for _, text := range cases {
		hits := g.Match(text, "ru", 0.50, 10)
		if !containsCanonical(hits, "Маяпур") {
			t.Errorf("expected «Маяпур» hint for %q (via alias); got %v", text, hits)
		}
		for _, h := range hits {
			if h.Canonical == "Майяпур" || h.Canonical == "Майапур" || h.Canonical == "Майпур" {
				t.Errorf("alias leaked into hint output for %q: %+v", text, h)
			}
		}
	}
}

func TestMatch_ShortTermNeedsSubstring(t *testing.T) {
	g := Build(testEntries())
	// "ом" is 2 chars normalized. Trigram fuzzy alone would false-
	// positive on any text containing "ом". Substring check requires
	// the canonical to literally appear.
	text := "Мы говорим о домах и комнатах."
	hits := g.Match(text, "ru", 0.50, 10)
	if containsCanonical(hits, "ом") {
		t.Errorf("short canonical 'ом' should NOT match noise %q", text)
	}
}

func TestMatch_MultipleHits(t *testing.T) {
	g := Build(testEntries())
	text := "Когда Кришна и Арджуна на Курукшетре, Бхагавад-гита глаголит:"
	hits := g.Match(text, "ru", 0.50, 10)
	wants := []string{"Кришна", "Арджуна", "Курукшетра", "Бхагавад-гита"}
	for _, w := range wants {
		if !containsCanonical(hits, w) {
			t.Errorf("expected %q in hits for %q; got %v", w, text, hits)
		}
	}
}

func TestRenderExtraPrompt_Empty(t *testing.T) {
	if got := RenderExtraPrompt(nil); got != "" {
		t.Errorf("empty hints should render empty string, got %q", got)
	}
}

func TestRenderExtraPrompt_Format(t *testing.T) {
	hints := []Hint{
		{Canonical: "Бхагавад-гита", Category: "book", Hint: "always with д"},
		{Canonical: "Кришна", Category: "name"},
	}
	out := RenderExtraPrompt(hints)
	if !strings.Contains(out, "Бхагавад-гита (book) — always with д") {
		t.Errorf("missing first hint formatting in:\n%s", out)
	}
	if !strings.Contains(out, "Кришна (name)\n") {
		t.Errorf("missing second hint (no description) in:\n%s", out)
	}
}

func TestEmbedded_RealGlossary(t *testing.T) {
	g, err := Embedded()
	if err != nil {
		t.Fatalf("embedded: %v", err)
	}
	if len(g.Entries) < 100 {
		t.Errorf("expected ≥100 entries, got %d", len(g.Entries))
	}
	// Smoke test: real corpus mangled form should match the right canonical.
	hits := g.Match("Лекция по Бхагават-гите", "ru", 0.50, 5)
	if !containsCanonical(hits, "Бхагавад-гита") {
		t.Errorf("expected Бхагавад-гита from real glossary, got %v", hits)
	}
}

// ----- test helpers -----

func testEntries() []Entry {
	return []Entry{
		{Canonical: map[string]string{"ru": "Бхагавад-гита", "en": "Bhagavad-gītā"}, Category: "book", Hint: "always with д"},
		{Canonical: map[string]string{"ru": "Шримад-Бхагаватам", "en": "Śrīmad-Bhāgavatam"}, Category: "book"},
		{Canonical: map[string]string{"ru": "Шрила Прабхупада", "en": "Śrīla Prabhupāda"}, Category: "name"},
		{Canonical: map[string]string{"ru": "Кришна", "en": "Kṛṣṇa"}, Category: "name"},
		{Canonical: map[string]string{"ru": "Арджуна", "en": "Arjuna"}, Category: "name"},
		{Canonical: map[string]string{"ru": "Курукшетра", "en": "Kurukṣetra"}, Category: "place"},
		{Canonical: map[string]string{"ru": "ом", "en": "oṁ"}, Category: "mantra"},
	}
}

func containsCanonical(hits []Hint, canonical string) bool {
	for _, h := range hits {
		if h.Canonical == canonical {
			return true
		}
	}
	return false
}
