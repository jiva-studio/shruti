package script_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
)

// The transcript is the one thing this archive gives that most do not, and for
// a while every bit of structure in it was thrown away: the function stripped
// all markup and called the result Markdown, which it was only in the sense
// that a paragraph is a blank line. Headings said where a passage began and
// went out with the tags.
//
// These run on markup written here rather than on a saved page, so they run
// everywhere, including in CI.

func transcriptOf(t *testing.T, inner string) script.Fields {
	t.Helper()
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	html := `<html lang="ru"><body>
		<script type="application/ld+json">{"name":"Лекция","author":{"name":"Леонид Тугутов"},"datePublished":"2023-01-23"}</script>
		<div itemprop="transcript">` + inner + `</div></body></html>`
	got, err := r.Run(context.Background(), "audioveda",
		script.Page{HTML: html}, []script.Item{{URL: "u", Filename: "x.mp3"}})
	if err != nil {
		t.Fatal(err)
	}
	return got["u"]
}

func TestHeadingsSurviveAsHeadings(t *testing.T) {
	f := transcriptOf(t, `<h2>Первая часть</h2><p>Текст.</p><h3>Вопросы</h3><p>Ответ.</p>`)

	for _, want := range []string{"## Первая часть", "### Вопросы"} {
		if !strings.Contains(f.PageText, want) {
			t.Errorf("missing %q in:\n%s", want, f.PageText)
		}
	}
	// A heading must own its line, or it is not a heading.
	for _, line := range strings.Split(f.PageText, "\n") {
		if strings.HasPrefix(line, "#") && strings.Contains(line, "Текст.") {
			t.Errorf("heading ran into the paragraph: %q", line)
		}
	}
}

// A <br> inside a heading would cut the heading in half, since a Markdown
// heading ends at the newline.
func TestAHeadingIsFlattenedOntoOneLine(t *testing.T) {
	f := transcriptOf(t, `<h2>Шримад<br>Бхагаватам</h2><p>Текст.</p>`)
	if !strings.Contains(f.PageText, "## Шримад Бхагаватам") {
		t.Errorf("= %q", f.PageText)
	}
}

func TestEmphasisSurvives(t *testing.T) {
	f := transcriptOf(t, `<p>Это <strong>очень</strong> важно, и <em>только</em> это.</p>`)
	if !strings.Contains(f.PageText, "**очень**") || !strings.Contains(f.PageText, "*только*") {
		t.Errorf("= %q", f.PageText)
	}
}

// "** word **" is not emphasis in any reader; it is two asterisks. The marker
// has to sit against the words, not against the space around them.
func TestTheMarkerSitsAgainstTheWords(t *testing.T) {
	f := transcriptOf(t, `<p>Это <strong> важно </strong> здесь.</p>`)
	// An opening marker followed by a space, or a space before a closing one,
	// is what no reader treats as emphasis. A closing marker followed by a
	// space is just the next word, and fine.
	if strings.Contains(f.PageText, "** важно") || strings.Contains(f.PageText, "важно **") {
		t.Errorf("the marker was left against the space: %q", f.PageText)
	}
	if !strings.Contains(f.PageText, "Это **важно** здесь.") {
		t.Errorf("= %q", f.PageText)
	}
}

func TestEmptyEmphasisAddsNoMarkers(t *testing.T) {
	f := transcriptOf(t, `<p>Слово<strong></strong> и <em> </em>другое.</p>`)
	if strings.Contains(f.PageText, "*") {
		t.Errorf("markers around nothing: %q", f.PageText)
	}
}

// A line break inside a paragraph is a break, not a space — verse quoted in a
// lecture is the obvious case.
func TestALineBreakIsAHardBreak(t *testing.T) {
	f := transcriptOf(t, `<p>первая строка<br>вторая строка</p>`)
	if !strings.Contains(f.PageText, "первая строка  \nвторая строка") {
		t.Errorf("= %q", f.PageText)
	}
}

func TestParagraphsStaySeparate(t *testing.T) {
	f := transcriptOf(t, `<p>Первый.</p><p>Второй.</p>`)
	if !strings.Contains(f.PageText, "Первый.\n\nВторой.") {
		t.Errorf("= %q", f.PageText)
	}
}

// Every link keeps its words and loses its address, wherever it points. On real
// transcripts the addresses are tag pages, transcribers' profiles and one
// citation to another library — none of which we read, and all of which we
// would pay to embed. The words stay because they are in the sentence.
func TestLinksKeepTheirWordsAndLoseTheirAddress(t *testing.T) {
	f := transcriptOf(t, `<p>Это уровень <a href="/tags/273" title="бхакти" target="_blank">бхакти</a>, см. <a href="https://vedabase.io/ru/library/sb/7/15/38-39/">тексты 38-39</a>.</p>`)
	for _, gone := range []string{"/tags/273", "vedabase.io", "]("} {
		if strings.Contains(f.PageText, gone) {
			t.Errorf("%q survived in %q", gone, f.PageText)
		}
	}
	if !strings.Contains(f.PageText, "Это уровень бхакти, см. тексты 38-39.") {
		t.Errorf("= %q", f.PageText)
	}
}

// Who transcribed the lecture, and where they live, is a credit worth having on
// the site and is not part of what was said.
func TestTheTranscriberCreditIsNotTheLecture(t *testing.T) {
	f := transcriptOf(t, `<p>Шримад Бхагаватам ки джай!</p><div class="staff">транскрибирование: <span class="name"><a href="/users/91741">Елена Брайнис</a></span><span class="city">| Иерусалим | Израиль</span> | 19 August 2020</div>`)
	for _, gone := range []string{"Елена Брайнис", "Иерусалим", "транскрибирование"} {
		if strings.Contains(f.PageText, gone) {
			t.Errorf("%q survived in %q", gone, f.PageText)
		}
	}
	if !strings.Contains(f.PageText, "Шримад Бхагаватам ки джай!") {
		t.Errorf("= %q", f.PageText)
	}
}

// Emphasis inside link text stays inside the label rather than being stranded
// around it.
// Emphasis inside link text survives the link being unwrapped.
func TestEmphasisInsideALinkSurvives(t *testing.T) {
	f := transcriptOf(t, `<p>и <a href="/x"><em>слово</em></a> тут</p>`)
	if !strings.Contains(f.PageText, "*слово*") || strings.Contains(f.PageText, "/x") {
		t.Errorf("= %q", f.PageText)
	}
}

// The timings are the archive's own clock and do not line up with our re-encode
// of the audio, so they are dropped. That was true before and stays true.
func TestTimingsAreStillDropped(t *testing.T) {
	f := transcriptOf(t, `<p><span class="timing">00:14:32</span>Он сказал.</p>`)
	if strings.Contains(f.PageText, "00:14:32") {
		t.Errorf("a timing survived: %q", f.PageText)
	}
	if !strings.Contains(f.PageText, "Он сказал.") {
		t.Errorf("= %q", f.PageText)
	}
}

func TestNoMarkupSurvives(t *testing.T) {
	f := transcriptOf(t, `<p>Текст <span class="x">внутри</span> и <div>ещё</div>.</p>`)
	if strings.Contains(f.PageText, "<") || strings.Contains(f.PageText, ">") {
		t.Errorf("markup left in: %q", f.PageText)
	}
}

// A stray "&bdquo;" in the middle of a sentence is what nobody reports and
// everybody sees.
func TestEntitiesAreDecoded(t *testing.T) {
	f := transcriptOf(t, `<p>&bdquo;Бхагаватам&ldquo; &mdash; &sect;5 &frac12; &#1073;&nbsp;&rsquo;</p>`)
	for _, bad := range []string{"&bdquo;", "&ldquo;", "&mdash;", "&sect;", "&frac12;", "&rsquo;"} {
		if strings.Contains(f.PageText, bad) {
			t.Errorf("%s undecoded in %q", bad, f.PageText)
		}
	}
	if !strings.Contains(f.PageText, "„") || !strings.Contains(f.PageText, "½") {
		t.Errorf("= %q", f.PageText)
	}
}

// The page states its language outright. Nothing is inferred from the text —
// but where it is stated, not reading it is just not looking.
func TestTheStatedLanguageIsRead(t *testing.T) {
	f := transcriptOf(t, `<p>Текст.</p>`)
	if f.Language != "ru" {
		t.Errorf("language = %q, want ru — the page says lang=\"ru\"", f.Language)
	}
}

func TestAPageWithNoTranscriptYieldsNoText(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Run(context.Background(), "audioveda",
		script.Page{HTML: `<html lang="ru"><body><p>ничего</p></body></html>`},
		[]script.Item{{URL: "u", Filename: "x.mp3"}})
	if err != nil {
		t.Fatal(err)
	}
	if got["u"].PageText != "" {
		t.Errorf("= %q", got["u"].PageText)
	}
}

// The archive states how long the recording runs, in the ISO 8601 form
// schema.org uses. It is the one source here that gives this for free: an
// mp3's length is in no header, only in its first frame, so anywhere else it
// costs a request per recording.
func TestTheStatedDurationIsRead(t *testing.T) {
	for iso, want := range map[string]int{
		"PT1H10M45S": 4245,
		"PT45M":      2700,
		"PT2H":       7200,
		"PT90S":      90,
		"PT1H0M0S":   3600,
		// Unreadable, absent, or longer than any talk: nothing rather than a
		// guess, because a wrong number would be believed.
		"":        0,
		"1:10:45": 0,
		"PT":      0,
		"PT200H":  0,
		"P1DT2H":  0,
	} {
		f := durationOf(t, iso)
		if f.DurationS != want {
			t.Errorf("%q = %d, want %d", iso, f.DurationS, want)
		}
	}
}

func durationOf(t *testing.T, iso string) script.Fields {
	t.Helper()
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	ld := `{"name":"Лекция","author":{"name":"Леонид Тугутов"},"datePublished":"2023-01-23"`
	if iso != "" {
		ld += `,"duration":"` + iso + `"`
	}
	ld += `}`
	html := `<html lang="ru"><body><script type="application/ld+json">` + ld +
		`</script><div itemprop="transcript"><p>Текст.</p></div></body></html>`
	got, err := r.Run(context.Background(), "audioveda",
		script.Page{HTML: html}, []script.Item{{URL: "u", Filename: "x.mp3"}})
	if err != nil {
		t.Fatal(err)
	}
	return got["u"]
}
