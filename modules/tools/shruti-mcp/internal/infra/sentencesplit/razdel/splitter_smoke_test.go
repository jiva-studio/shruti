//go:build smoke

package razdelsplit

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

// TestSplitter_Razdel hits the real razdel subprocess. Skipped in
// non-smoke runs because it requires `pip install razdel` in the
// system python3.
func TestSplitter_Razdel(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	scriptPath := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "scripts", "sentencesplit", "razdel.py")

	s, err := New(Config{ScriptPath: scriptPath})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	cases := []struct {
		text string
		want int
	}{
		{"Привет, мир. Как дела?", 2},
		{"Шри Прабхупада сказал т.е. это важно. Сарва-дхарман.", 2},
		// razdel correctly recognises "8.13" as a reference, not a sentence end.
		{"БГ 8.13: Ya prayati. So om ity ekaksaram brahma.", 2},
	}
	for _, tc := range cases {
		got, err := s.Split(context.Background(), tc.text)
		if err != nil {
			t.Fatalf("Split(%q): %v", tc.text, err)
		}
		if len(got) != tc.want {
			t.Errorf("Split(%q) returned %d sentences, want %d: %+v", tc.text, len(got), tc.want, got)
		}
		for _, s := range got {
			t.Logf("  [%d-%d] %s", s.Start, s.Stop, s.Text)
		}
	}
}
