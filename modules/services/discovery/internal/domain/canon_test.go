package domain_test

import (
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// A citation to a book not on this list is dropped as an invention. The list
// held eight books while the corpus held nineteen, so every reference to the
// other eleven was thrown away — and a dropped reference leaves no trace, so
// nothing anywhere said it was happening.
func TestEveryBookTheCorpusHoldsIsAddressable(t *testing.T) {
	for _, code := range []string{
		"BG", "SB", "CC_ADI", "CC_MADHYA", "CC_ANTYA",
		"ISO", "NOD", "NOI", "BS", "NBS", "MM",
		"TQK", "TLC", "KB", "RMN", "MK", "LETTERS",
	} {
		if !domain.Addressable(code) {
			t.Errorf("%s is a book the corpus holds and a citation to it would be dropped", code)
		}
	}
}

// And a book nobody holds stays unaddressable, or the check buys nothing.
func TestABookNobodyHoldsIsNot(t *testing.T) {
	for _, code := range []string{"QURAN", "BIBLE", "", "   ", "XYZ"} {
		if domain.Addressable(code) {
			t.Errorf("%q was accepted", code)
		}
	}
}

// Case and spacing are settled on the way in, so two spellings of one book are
// one book.
func TestSpellingIsSettled(t *testing.T) {
	for _, code := range []string{"bg", " BG ", "Bg"} {
		if !domain.Addressable(code) {
			t.Errorf("%q was not recognised", code)
		}
	}
}
