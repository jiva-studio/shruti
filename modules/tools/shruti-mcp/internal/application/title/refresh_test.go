package title

import "testing"

func TestSupportedLanguage(t *testing.T) {
	cases := []struct {
		code string
		want bool
	}{
		{"en", true},
		{"ru", true},
		{"hi", true},
		{"EN", false}, // case-sensitive — pipeline writes lower-case codes
		{"de", false},
		{"", false},
		{"english", false},
	}
	for _, c := range cases {
		got := SupportedLanguage(c.code)
		if got != c.want {
			t.Errorf("SupportedLanguage(%q) = %v, want %v", c.code, got, c.want)
		}
	}
}
