package emailotp

import (
	"strings"
	"testing"
)

// Exact, script, prefix and fallback locale resolution, and the code in
// both bodies.
func TestOtpEmailContent_Localized(t *testing.T) {
	cases := []struct {
		locale string
		subSub string // substring expected in the subject
	}{
		{"en", "sign-in code"},
		{"ru", "код для входа"},
		{"uk", "код для входу"},
		{"sr-Latn", "kod za prijavu"},
		{"sr-Cyrl", "код за пријаву"},
		{"ru-RU", "код для входа"}, // prefix match
		{"de", "sign-in code"},     // unmapped → English
		{"", "sign-in code"},       // empty → English
	}
	for _, c := range cases {
		subject, text, html := otpEmailContent("123456", c.locale)
		if !strings.Contains(subject, c.subSub) {
			t.Errorf("locale %q: subject %q missing %q", c.locale, subject, c.subSub)
		}
		if !strings.Contains(text, "123456") {
			t.Errorf("locale %q: text body missing the code", c.locale)
		}
		if !strings.Contains(html, "123456") || !strings.Contains(html, "<html") {
			t.Errorf("locale %q: html body missing code or markup", c.locale)
		}
	}
}
