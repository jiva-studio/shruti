package domain

import "encoding/binary"

// Audio format used everywhere in Shruti: signed 16-bit little-endian PCM,
// mono, 16 kHz per source channel. Capture and ASR both assume exactly this.
const (
	SampleRate    = 16000 // Hz
	BytesPerFrame = 2     // int16, one mono sample
)

// Origin is where a captured audio channel comes from. It is provider-agnostic
// domain vocabulary — an adapter maps a physical device to one of these.
type Origin string

const (
	OriginMic    Origin = "mic"    // a microphone (a person in the room): "я"
	OriginSystem Origin = "system" // everything the machine plays (Zoom/browser): "они"
	OriginLine   Origin = "line"   // an external line-in / other capture
)

// AudioLayout tells the application how a transcriber wants its N source
// channels delivered on the wire.
type AudioLayout int

const (
	// LayoutMixed: sum all sources into ONE mono stream (one ASR pass). Used by
	// engines that run one model instance (e.g. parakeet on the ANE, where two
	// concurrent inferences contend).
	LayoutMixed AudioLayout = iota
	// LayoutMultiChannel: keep every source as its own interleaved channel, so
	// the engine transcribes each independently (e.g. Deepgram multichannel).
	LayoutMultiChannel
)

// MixMono sums N mono s16le frames into one mono frame, clipping to int16. It is
// the LayoutMixed packer. Frames of unequal length are summed up to the length
// of the shortest (the sources are paired 1:1 per capture tick).
func MixMono(frames ...[]byte) []byte {
	n := minEvenLen(frames)
	if n == 0 {
		return longest(frames)
	}
	out := make([]byte, n)
	for i := 0; i < n; i += 2 {
		var s int32
		for _, f := range frames {
			s += int32(int16(binary.LittleEndian.Uint16(f[i:])))
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

// Interleave weaves N mono s16le frames into one interleaved N-channel frame:
// out = [f0[0], f1[0], … fN[0], f0[1], f1[1], …]. It is the LayoutMultiChannel
// packer; channel index i in the result is source i in the input order.
func Interleave(frames ...[]byte) []byte {
	c := len(frames)
	if c == 0 {
		return nil
	}
	if c == 1 {
		return frames[0]
	}
	n := minEvenLen(frames)
	out := make([]byte, n*c)
	for i, w := 0, 0; i < n; i += 2 {
		for _, f := range frames {
			out[w], out[w+1] = f[i], f[i+1]
			w += 2
		}
	}
	return out
}

// minEvenLen returns the shortest frame length rounded down to a whole sample.
func minEvenLen(frames [][]byte) int {
	n := -1
	for _, f := range frames {
		if n < 0 || len(f) < n {
			n = len(f)
		}
	}
	if n < 0 {
		return 0
	}
	return n - n%2
}

func longest(frames [][]byte) []byte {
	var out []byte
	for _, f := range frames {
		if len(f) > len(out) {
			out = f
		}
	}
	return out
}
