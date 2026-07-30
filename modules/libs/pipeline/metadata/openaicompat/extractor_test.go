package openaicompatmeta

import "testing"

func TestParseDate(t *testing.T) {
	cases := []struct {
		in   string
		want string // "" = expect ok==false
	}{
		{"2026-04-18", "2026-04-18"},
		{"April 18, 2026", "2026-04-18"},
		{"18 April 2026", "2026-04-18"},
		{"Apr 18 2026", "2026-04-18"},
		{"  2026-04-18  ", "2026-04-18"},
		{"2026-04", "2026-04-01"},
		{"2026", "2026-01-01"},
		{"", ""},
		{"not a date", ""},
	}
	for _, c := range cases {
		got, ok := parseDate(c.in)
		if c.want == "" {
			if ok {
				t.Errorf("parseDate(%q) = %s, want no date", c.in, got.Format("2006-01-02"))
			}
			continue
		}
		if !ok || got.Format("2006-01-02") != c.want {
			t.Errorf("parseDate(%q) = (%s, %v), want %s", c.in, got.Format("2006-01-02"), ok, c.want)
		}
	}
}
