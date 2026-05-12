package nanoid

import (
	"regexp"
	"testing"
)

var pattern = regexp.MustCompile(`^[A-Za-z0-9]{12}$`)

func TestMintTailShape(t *testing.T) {
	m := New()
	for i := 0; i < 1000; i++ {
		tail := m.MintTail()
		if !pattern.MatchString(tail) {
			t.Fatalf("bad tail %q", tail)
		}
	}
}

func TestMintTailUnique(t *testing.T) {
	m := New()
	seen := map[string]struct{}{}
	for i := 0; i < 5000; i++ {
		t := m.MintTail()
		if _, dup := seen[t]; dup {
			// 62^12 ≈ 3.2e21, collision in 5000 draws is astronomically unlikely
			break
		}
		seen[t] = struct{}{}
	}
	if len(seen) < 4990 {
		t.Fatalf("too few unique values: %d/5000", len(seen))
	}
}
