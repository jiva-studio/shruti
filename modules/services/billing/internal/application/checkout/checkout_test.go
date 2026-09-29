package checkout

import "testing"

func TestDollars(t *testing.T) {
	cases := map[int]string{299: "2.99", 2999: "29.99", 100: "1.00", 5: "0.05", 0: "0.00"}
	for cents, want := range cases {
		if got := dollars(cents); got != want {
			t.Errorf("dollars(%d) = %q, want %q", cents, got, want)
		}
	}
}
