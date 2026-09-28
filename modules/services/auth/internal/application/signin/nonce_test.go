package signin

import "testing"

// TestNonceEqualRefusesAnAbsentClaim: an empty claim never matches, even an
// empty expectation.
func TestNonceEqualRefusesAnAbsentClaim(t *testing.T) {
	if nonceEqual("", "") {
		t.Fatal("empty claim matched an empty expectation")
	}
	if !nonceEqual("n", "n") {
		t.Fatal("equal nonces did not match")
	}
}
