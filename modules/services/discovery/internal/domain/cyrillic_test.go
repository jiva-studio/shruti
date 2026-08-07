package domain_test

import (
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// One speaker is filed in Cyrillic by a Russian archive and in Latin by an
// English one, and they are one person.
//
// The defect this guards was not that the two failed to meet — it was that the
// Cyrillic one did not exist. Key kept only [a-z0-9], so a Russian name reduced
// to nothing, an empty key resolves to nobody, and on the live corpus 5399 of
// 5400 recordings that named their speaker were attached to no speaker at all.

func TestACyrillicNameHasAKey(t *testing.T) {
	for _, name := range []string{
		"Сарвагья дас", "Локанатха Свами", "Олег Торсунов",
		"Е.М. Ватсала дас", "Е.С. Бхакти Викаша Свами Махарадж",
	} {
		if got := domain.Key(name); got == "" {
			t.Errorf("Key(%q) is empty; the speaker would be attached to nobody", name)
		}
	}
}

// The forms of address are dropped in both alphabets, or the same person is two.
func TestCyrillicFormsOfAddressAreDropped(t *testing.T) {
	for name, want := range map[string]string{
		"Е.М. Сарвагья дас":                 "сарвагья",
		"Сарвагья прабху":                   "сарвагья",
		"Е.С. Бхакти Викаша Свами Махарадж": "бхакти викаша",
		"Локанатха Свами":                   "локанатха",
		"Его Милость Ватсала дас":           "ватсала",
		"Шрила Прабхупада":                  "прабхупада",
	} {
		if got := domain.Key(name); got != want {
			t.Errorf("Key(%q) = %q, want %q", name, got, want)
		}
	}
}

// A woman stays distinguishable in Cyrillic too: it is the one part of a form
// of address that distinguishes rather than decorates.
func TestCyrillicKeepsTheFeminine(t *testing.T) {
	woman := domain.Key("Рукмини прия матаджи")
	man := domain.Key("Рукмини прия дас")
	if woman == man {
		t.Errorf("both = %q; two people folded into one", woman)
	}
	if woman == "" || man == "" {
		t.Errorf("woman=%q man=%q", woman, man)
	}
}

// Fold proposes that two spellings are one person. Across alphabets is the case
// it exists for here.
func TestFoldMeetsAcrossAlphabets(t *testing.T) {
	for _, p := range [][2]string{
		{"Локанатха Свами", "Lokanatha Swami"},
		{"Радханатх Свами", "Radhanath Swami"},
		{"Шачинандана Свами", "Sacinandana Swami"},
		{"Кадамба Канана Свами", "Kadamba Kanana Swami"},
		{"Е.С. Бхакти Викаша Свами Махарадж", "Bhakti Vikasa Swami"},
		{"Бхакти Чайтанья Свами", "Bhakti Caitanya Swami"},
	} {
		a, b := domain.Fold(domain.Key(p[0])), domain.Fold(domain.Key(p[1]))
		if a != b {
			t.Errorf("Fold(%q)=%q ≠ Fold(%q)=%q", p[0], a, p[1], b)
		}
	}
}

// And where it does not meet, it must not pretend to. Russian renders the
// Sanskrit "jña" as "гья", so "Сарвагья" and "Sarvajna" are genuinely apart —
// that is a case for somebody joining them by hand, not for a looser rule that
// would start joining different people.
func TestFoldDoesNotInventMatches(t *testing.T) {
	for _, p := range [][2]string{
		{"Локанатха Свами", "Радханатх Свами"},
		{"Бхакти Викаша Свами", "Бхакти Чайтанья Свами"},
	} {
		if a, b := domain.Fold(domain.Key(p[0])), domain.Fold(domain.Key(p[1])); a == b {
			t.Errorf("%q and %q both fold to %q", p[0], p[1], a)
		}
	}
}

// Two ways of saying the same thing are one marker, not two. "Radhanath Swami
// Maharaja" became "Radhanath Swami Swami": the outer marker was replaced by
// its canonical form and appended to the inner one, which was still there.
func TestARepeatedFormOfAddressIsNotDoubled(t *testing.T) {
	for name, want := range map[string]string{
		"HH Radhanath Swami Maharaja":       "Radhanath Swami",
		"Е.С. Бхакти Викаша Свами Махарадж": "Бхакти Викаша Свами",
		"Е.М. Сарвагья дас":                 "Сарвагья дас",
		"Рукмини прия матаджи":              "Рукмини прия деви даси",
		"Bhakti Charu Swami":                "Bhakti Charu Swami",
		"Rukmini Priya Devi Dasi Mataji":    "Rukmini Priya Devi Dasi",
	} {
		if got := domain.Name(name); got != want {
			t.Errorf("Name(%q) = %q, want %q", name, got, want)
		}
	}
}
