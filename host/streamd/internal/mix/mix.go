// Package mix is streamd's audio front-end for host-authoritative multichannel.
// The client sends interleaved N-channel s16le PCM; streamd de-interleaves it,
// mixes it down to the one mono stream the ASR engine consumes, and tracks
// per-channel energy so a mixed final can be attributed to the source (a
// dedicated mic) that was actually speaking — recovering per-channel speaker
// labels without running N model instances on the ANE.
package mix

import (
	"encoding/binary"
	"sync"
)

// Deinterleave splits an interleaved N-channel s16le frame into channels mono
// frames. Channel c gets samples at positions c, c+N, c+2N, … A channels value
// <= 1 returns the frame unchanged as a single channel.
func Deinterleave(frame []byte, channels int) [][]byte {
	if channels <= 1 {
		return [][]byte{frame}
	}
	samples := len(frame) / 2 / channels
	out := make([][]byte, channels)
	for c := range out {
		out[c] = make([]byte, samples*2)
	}
	for i := 0; i < samples; i++ {
		base := i * channels * 2
		for c := 0; c < channels; c++ {
			b := base + c*2
			out[c][i*2] = frame[b]
			out[c][i*2+1] = frame[b+1]
		}
	}
	return out
}

// MixMono sums N mono s16le frames into one, clipping to int16.
func MixMono(chans [][]byte) []byte {
	if len(chans) == 1 {
		return chans[0]
	}
	n := -1
	for _, c := range chans {
		if n < 0 || len(c) < n {
			n = len(c)
		}
	}
	if n < 0 {
		return nil
	}
	n -= n % 2
	out := make([]byte, n)
	for i := 0; i < n; i += 2 {
		var s int32
		for _, c := range chans {
			s += int32(int16(binary.LittleEndian.Uint16(c[i:])))
		}
		if s > 32767 {
			s = 32767
		} else if s < -32768 {
			s = -32768
		}
		binary.LittleEndian.PutUint16(out[i:], uint16(int16(s)))
	}
	return out
}

// energy returns the summed squared amplitude of a mono s16le frame.
func energy(frame []byte) float64 {
	var e float64
	for i := 0; i+1 < len(frame); i += 2 {
		s := float64(int16(binary.LittleEndian.Uint16(frame[i:])))
		e += s * s
	}
	return e
}

// Attributor accumulates per-channel energy across a segment and, when a final
// is emitted, names the dominant channel's fixed speaker (if it has one). It is
// safe for concurrent use: the PCM pump calls Observe while the ASR pump calls
// DominantSpeaker.
type Attributor struct {
	mu       sync.Mutex
	speakers []string  // per-channel fixed label ("" = diarize this channel)
	energy   []float64 // accumulated since the last DominantSpeaker
}

// NewAttributor builds an attributor for the given per-channel speaker labels.
func NewAttributor(speakers []string) *Attributor {
	return &Attributor{speakers: speakers, energy: make([]float64, len(speakers))}
}

// Observe adds one tick of per-channel mono frames to the running energy.
func (a *Attributor) Observe(chans [][]byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := 0; c < len(chans) && c < len(a.energy); c++ {
		a.energy[c] += energy(chans[c])
	}
}

// DominantSpeaker returns the fixed speaker label of the loudest channel since
// the last call and resets the accumulator. ok is false when the loudest
// channel has no fixed label (leave the engine's diarization label in place) or
// when no energy was seen. The reset means each final is attributed to whoever
// spoke during that segment.
func (a *Attributor) DominantSpeaker() (label string, ok bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	best, bestE := -1, 0.0
	for c, e := range a.energy {
		if e > bestE {
			best, bestE = c, e
		}
	}
	for i := range a.energy {
		a.energy[i] = 0
	}
	if best < 0 || a.speakers[best] == "" {
		return "", false
	}
	return a.speakers[best], true
}
