package domain_test

import (
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

func TestNameSettlesFormsOfAddress(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"His Holiness Radhanath Swami", "Radhanath Swami"},
		{"Radhanath Sw", "Radhanath Swami"},
		{"Radhanath Maharaja", "Radhanath Swami"},
		{"HG Radha Gopinath Das", "Radha Gopinath Das"},
		{"Radha Gopinath Prabhu", "Radha Gopinath"},
		{"Adwait Acharya Pr", "Adwait Acharya"},
		{"Her Grace Urmila Mataji", "Urmila Devi Dasi"},
		{"Kalindi Devi Dasi", "Kalindi Devi Dasi"},
		{"Sri Giridhari Prabhu", "Giridhari"},
		{"His_Holiness_Bhakti_Caitanya_Swami", "Bhakti Caitanya Swami"},
	} {
		if got := domain.Name(c.in); got != c.want {
			t.Errorf("Name(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// One speaker under four spellings is one key.
func TestKeyGathersSpellings(t *testing.T) {
	same := []string{
		"Radhanath Swami", "Radhanath Sw", "Radhanath Maharaja",
		"HH Radhanath Swami", "Radhanath Pr",
	}
	want := domain.Key(same[0])
	for _, s := range same[1:] {
		if got := domain.Key(s); got != want {
			t.Errorf("Key(%q) = %q, want %q", s, got, want)
		}
	}
}

// Dasi and Mataji say the speaker is a woman, which distinguishes rather than
// decorates: folding it merged two people.
func TestKeyKeepsWomenApart(t *testing.T) {
	if domain.Key("Govinda Prabhu") == domain.Key("HG Govinda Dasi Mataji") {
		t.Fatal("a Prabhu and a Dasi folded into one person")
	}
	if domain.Key("Kalindi Mataji") != domain.Key("Kalindi Devi Dasi") {
		t.Error("two spellings of one woman did not meet")
	}
}

func TestFoldMeetsRomanisations(t *testing.T) {
	for _, pair := range [][2]string{
		{"Chandramouli Swami", "Candramauli Swami"},
		{"Bhakti Charu Swami", "Bhakti Caru Swami"},
		{"Gopal Krishna Goswami", "Gopal Krsna Goswami"},
		{"Bhakti Vikas Sw", "Bhakti Vikasa Sw"},
		{"Radhanatha Swami", "Radhanath Swami"},
	} {
		if a, b := domain.Fold(domain.Key(pair[0])), domain.Fold(domain.Key(pair[1])); a != b {
			t.Errorf("Fold(%q)=%q ≠ Fold(%q)=%q", pair[0], a, pair[1], b)
		}
	}
}

// The fold is coarse on purpose, but not so coarse that initials collide.
func TestFoldKeepsDifferentPeopleApart(t *testing.T) {
	for _, pair := range [][2]string{
		{"Bhanu Swami", "Charu Prabhu"},
		{"Gopal Krishna Goswami", "Bhurijan Prabhu"},
	} {
		if a, b := domain.Fold(domain.Key(pair[0])), domain.Fold(domain.Key(pair[1])); a == b {
			t.Errorf("%q and %q both fold to %q", pair[0], pair[1], a)
		}
	}
}

func TestPlaceDropsTheOrganisation(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"ISKCON Chennai", "Chennai"},
		{"ISKCON Chowpatty", "Chowpatty"},
		{"Iskcon_Los_Angeles", "Los Angeles"},
		{"Bhaktivedanta Manor", "Bhaktivedanta Manor"},
		{"Vrindavan", "Vrindavan"},
		// An organisation with no place after it says no more than "somewhere".
		{"ISKCON", ""},
	} {
		if got := domain.Place(c.in); got != c.want {
			t.Errorf("Place(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
