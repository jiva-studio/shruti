package ask

import (
	"testing"
	"time"
)

// The model answers with text and can answer with anything. What it says is
// checked before it becomes a filter, because a wrong field costs the asker
// every result and they cannot see why.

func TestALanguageIsACodeOrNothing(t *testing.T) {
	for given, want := range map[string]string{
		"ru": "ru", "EN": "en", "russian": "", "Russian": "", "r": "", "": "",
	} {
		if got := (reply{Language: given}).filter().Language; got != want {
			t.Errorf("%q -> %q, want %q", given, got, want)
		}
	}
}

// A reference to a book the corpus cannot address is an invention. It is
// checked against the canon and dropped when it fails, rather than filtering
// every recording away.
func TestOnlyAReferenceTheCorpusCanAddressSurvives(t *testing.T) {
	for given, want := range map[string]string{
		"BG 2.13":     "BG 2.13",
		"bg 2.13":     "BG 2.13",
		"SB 1.2.10":   "SB 1.2.10",
		"QURAN 2.255": "",
		"BG":          "",
		"":            "",
		"2.13":        "",
	} {
		if got := (reply{Ref: given}).filter().Ref; got != want {
			t.Errorf("%q -> %q, want %q", given, got, want)
		}
	}
}

// A date the model wrote in some other shape is nothing rather than a guess.
func TestAnUnreadableDateIsNothing(t *testing.T) {
	for _, given := range []string{"2012", "01.01.2012", "soon", "", "2012-13-45"} {
		if got := (reply{DateFrom: given}).filter().DateFrom; got != nil {
			t.Errorf("%q -> %v", given, got)
		}
	}
	got := (reply{DateFrom: "2012-01-01"}).filter().DateFrom
	if got == nil || !got.Equal(time.Date(2012, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("= %v", got)
	}
}
