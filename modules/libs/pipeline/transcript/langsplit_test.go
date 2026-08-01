package transcript

import (
	"reflect"
	"testing"
)

func segLang(lang string) RawSegment { return RawSegment{Language: lang} }

func TestSplitByLanguage(t *testing.T) {
	// Bilingual ~50/50: both clear the 10% + 3-sentence threshold → two groups.
	segs := []RawSegment{
		segLang("en"), segLang("ru"), segLang("en"), segLang("ru"),
		segLang("en"), segLang("ru"), segLang("en"), segLang("ru"),
	}
	groups := SplitByLanguage(segs, "en")
	if len(groups["en"]) != 4 || len(groups["ru"]) != 4 {
		t.Fatalf("bilingual split = en:%d ru:%d, want 4/4", len(groups["en"]), len(groups["ru"]))
	}

	// A stray below-threshold language folds into the primary (no junk variant).
	stray := make([]RawSegment, 0, 22)
	for i := 0; i < 20; i++ {
		stray = append(stray, segLang("en"))
	}
	stray = append(stray, segLang("hi"), segLang("hi")) // 2/22 ≈ 9% AND < 3 → folds
	g := SplitByLanguage(stray, "en")
	if len(g) != 1 || len(g["en"]) != 22 {
		m := map[string]int{}
		for k, v := range g {
			m[k] = len(v)
		}
		t.Fatalf("stray language should fold into primary: %v", m)
	}
}

func TestOrderedLanguages(t *testing.T) {
	groups := map[string][]RawSegment{"ru": nil, "en": nil, "hi": nil}
	if got := OrderedLanguages(groups, "ru"); !reflect.DeepEqual(got, []string{"ru", "en", "hi"}) {
		t.Fatalf("OrderedLanguages = %v, want primary first then alphabetical", got)
	}
}
