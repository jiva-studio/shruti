package track

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Audio describes the canonical (post-normalize) audio asset for a track.
// Immutable: callers fill an AudioSpec and pass it through NewAudio for
// validation, then read back through accessor methods.
//
// Currently the only existing in-tree consumer is the IsPlayable test;
// commit's stage payload uses a local DTO. The closed shape is kept so
// when those use cases adopt the value object, the migration is a
// search-and-replace rather than a re-design.
type Audio struct {
	trackID        ID
	originalPath   string
	normalizedPath string
	loudnessLUFS   float64
	bitrate        int
	durationMs     int64
	sizeBytes      int64
	channels       int
	sampleRate     int
}

// AudioSpec is the writable shape callers fill before constructing.
// Same field names as the old open struct so migration is purely the
// NewAudio call boundary.
type AudioSpec struct {
	TrackID        ID
	OriginalPath   string
	NormalizedPath string
	LoudnessLUFS   float64
	Bitrate        int
	DurationMs     int64
	SizeBytes      int64
	Channels       int
	SampleRate     int
}

// validChannelCounts mirrors what the audio_normalize stage will preserve
// from the source: mono, stereo, 5.1, 7.1. Anything else is unexpected
// and worth surfacing at construction.
var validChannelCounts = map[int]struct{}{
	1: {}, // mono
	2: {}, // stereo
	5: {}, // surround
	6: {}, // 5.1
	7: {}, // 6.1
	8: {}, // 7.1
}

// NewAudio validates the spec and returns an immutable Audio. Errors:
//   - duration_ms <= 0
//   - size_bytes <= 0
//   - bitrate <= 0
//   - channels not in {1,2,5,6,7,8}
//   - sample_rate <= 0
func NewAudio(spec AudioSpec) (Audio, error) {
	if spec.DurationMs <= 0 {
		return Audio{}, fmt.Errorf("audio: duration_ms must be > 0 (got %d)", spec.DurationMs)
	}
	if spec.SizeBytes <= 0 {
		return Audio{}, fmt.Errorf("audio: size_bytes must be > 0 (got %d)", spec.SizeBytes)
	}
	if spec.Bitrate <= 0 {
		return Audio{}, fmt.Errorf("audio: bitrate must be > 0 (got %d)", spec.Bitrate)
	}
	if _, ok := validChannelCounts[spec.Channels]; !ok {
		return Audio{}, fmt.Errorf("audio: channels=%d outside supported set {1,2,5,6,7,8}", spec.Channels)
	}
	if spec.SampleRate <= 0 {
		return Audio{}, fmt.Errorf("audio: sample_rate must be > 0 (got %d)", spec.SampleRate)
	}
	return Audio{
		trackID:        spec.TrackID,
		originalPath:   spec.OriginalPath,
		normalizedPath: spec.NormalizedPath,
		loudnessLUFS:   spec.LoudnessLUFS,
		bitrate:        spec.Bitrate,
		durationMs:     spec.DurationMs,
		sizeBytes:      spec.SizeBytes,
		channels:       spec.Channels,
		sampleRate:     spec.SampleRate,
	}, nil
}

// Accessors. Audio is all primitives — no defensive-copy concerns.

func (a Audio) TrackID() ID            { return a.trackID }
func (a Audio) OriginalPath() string   { return a.originalPath }
func (a Audio) NormalizedPath() string { return a.normalizedPath }
func (a Audio) LoudnessLUFS() float64  { return a.loudnessLUFS }
func (a Audio) Bitrate() int           { return a.bitrate }
func (a Audio) DurationMs() int64      { return a.durationMs }
func (a Audio) SizeBytes() int64       { return a.sizeBytes }
func (a Audio) Channels() int          { return a.channels }
func (a Audio) SampleRate() int        { return a.sampleRate }

// IsPlayable enforces the bare minimum any audio record must satisfy
// before commit lets it land in the catalog: nonzero duration and size.
// NewAudio already enforces this, so a reachable Audio always satisfies
// IsPlayable — the method stays as a defensive boundary check for
// callers loading audio from less-trusted sources.
func (a Audio) IsPlayable() error {
	if a.durationMs <= 0 {
		return errors.New("audio: duration_ms must be > 0")
	}
	if a.sizeBytes <= 0 {
		return errors.New("audio: size_bytes must be > 0")
	}
	return nil
}

// audioJSON is the wire shape — JSON tags match the catalog DB column
// names so a stage payload can be loaded back into Audio directly.
type audioJSON struct {
	TrackID        ID      `json:"track_id,omitempty"`
	OriginalPath   string  `json:"original_path,omitempty"`
	NormalizedPath string  `json:"normalized_path,omitempty"`
	LoudnessLUFS   float64 `json:"loudness_lufs,omitempty"`
	Bitrate        int     `json:"bitrate"`
	DurationMs     int64   `json:"duration_ms"`
	SizeBytes      int64   `json:"size_bytes"`
	Channels       int     `json:"channels"`
	SampleRate     int     `json:"sample_rate"`
}

func (a Audio) MarshalJSON() ([]byte, error) {
	return json.Marshal(audioJSON{
		TrackID:        a.trackID,
		OriginalPath:   a.originalPath,
		NormalizedPath: a.normalizedPath,
		LoudnessLUFS:   a.loudnessLUFS,
		Bitrate:        a.bitrate,
		DurationMs:     a.durationMs,
		SizeBytes:      a.sizeBytes,
		Channels:       a.channels,
		SampleRate:     a.sampleRate,
	})
}

// UnmarshalJSON skips re-validating — payloads on disk passed through
// NewAudio originally. Callers who need the check can run IsPlayable.
func (a *Audio) UnmarshalJSON(b []byte) error {
	var raw audioJSON
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	a.trackID = raw.TrackID
	a.originalPath = raw.OriginalPath
	a.normalizedPath = raw.NormalizedPath
	a.loudnessLUFS = raw.LoudnessLUFS
	a.bitrate = raw.Bitrate
	a.durationMs = raw.DurationMs
	a.sizeBytes = raw.SizeBytes
	a.channels = raw.Channels
	a.sampleRate = raw.SampleRate
	return nil
}
