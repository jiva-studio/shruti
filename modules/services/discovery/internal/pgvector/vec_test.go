package pgvector_test

import (
	"math"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/pgvector"
)

// Vectors go into the column as text and come back the same way. A round trip
// that loses precision quietly changes what is near what, which no search
// result would announce.
func TestRoundTripKeepsTheNumbers(t *testing.T) {
	want := []float32{0, 1, -1, 0.5, -0.001953125, 3.4028235e+38, 1.1754944e-38}

	got, err := pgvector.Parse(pgvector.Literal(want))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("%d values back, sent %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %v, sent %v", i, got[i], want[i])
		}
	}
}

func TestLiteralShape(t *testing.T) {
	if got := pgvector.Literal([]float32{1, 2}); got != "[1,2]" {
		t.Errorf("= %q", got)
	}
	// An empty vector is "[]", which pgvector rejects — the store turns this
	// into a NULL rather than sending it. Kept as a test so the shape is not
	// mistaken for something the database will take.
	if got := pgvector.Literal(nil); got != "[]" {
		t.Errorf("empty = %q", got)
	}
}

func TestParseTolerantOfSpacing(t *testing.T) {
	for _, in := range []string{"[1,2,3]", " [1, 2, 3] ", "1,2,3"} {
		got, err := pgvector.Parse(in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if len(got) != 3 || got[0] != 1 || got[2] != 3 {
			t.Errorf("%q = %v", in, got)
		}
	}
}

func TestParseRefusesNonsense(t *testing.T) {
	for _, in := range []string{"[1,two]", "[1,,2]", "[oops]"} {
		if got, err := pgvector.Parse(in); err == nil {
			t.Errorf("%q parsed as %v; a wrong vector must not pass for a right one", in, got)
		}
	}
}

func TestParseEmpty(t *testing.T) {
	got, err := pgvector.Parse("[]")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("= %v, want nothing", got)
	}
}

// Values that cannot be compared are worse than values that are missing: a NaN
// makes every distance meaningless without failing anything.
func TestNoSilentNaN(t *testing.T) {
	got, err := pgvector.Parse(pgvector.Literal([]float32{1, 2, 3}))
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range got {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			t.Errorf("[%d] = %v", i, v)
		}
	}
}
