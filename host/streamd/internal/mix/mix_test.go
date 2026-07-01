package mix

import (
	"encoding/binary"
	"testing"
)

// mono builds a mono s16le frame from samples.
func mono(samples ...int16) []byte {
	b := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(b[i*2:], uint16(s))
	}
	return b
}

func s16(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[i*2:]))
	}
	return out
}

func TestDeinterleaveThenMixRoundTrips(t *testing.T) {
	// two channels: [1,3] and [2,4] → interleaved [1,2,3,4]
	inter := mono(1, 2, 3, 4)
	chans := Deinterleave(inter, 2)
	if got := s16(chans[0]); got[0] != 1 || got[1] != 3 {
		t.Fatalf("ch0 = %v, want [1 3]", got)
	}
	if got := s16(chans[1]); got[0] != 2 || got[1] != 4 {
		t.Fatalf("ch1 = %v, want [2 4]", got)
	}
	if got := s16(MixMono(chans)); got[0] != 3 || got[1] != 7 {
		t.Fatalf("mix = %v, want [3 7]", got)
	}
}

func TestMixClips(t *testing.T) {
	got := s16(MixMono([][]byte{mono(30000), mono(30000)}))
	if got[0] != 32767 {
		t.Fatalf("clip = %d, want 32767", got[0])
	}
}

func TestAttributorPicksLoudestFixedSpeaker(t *testing.T) {
	a := NewAttributor([]string{"Я", ""}) // ch0 = mic "Я", ch1 = system (diarize)
	// ch0 loud, ch1 quiet → dominant is the mic.
	a.Observe([][]byte{mono(9000, 9000), mono(1, 1)})
	if label, ok := a.DominantSpeaker(); !ok || label != "Я" {
		t.Fatalf("dominant = %q,%v want Я,true", label, ok)
	}
	// energy reset; now ch1 (system, no fixed label) is loud → keep diarizer label.
	a.Observe([][]byte{mono(1, 1), mono(9000, 9000)})
	if label, ok := a.DominantSpeaker(); ok {
		t.Fatalf("dominant = %q,%v want \"\",false (system channel has no fixed label)", label, ok)
	}
}
