package domain

// Device is a selectable audio endpoint offered to the user (a sink whose
// monitor captures system output, a microphone source, or a live application
// stream). JSON tags are the UI contract consumed by the Vue frontend.
type Device struct {
	ID      string `json:"id"`      // PipeWire object.serial (pw-record --target)
	Name    string `json:"name"`    // node.name (stable-ish identifier)
	Label   string `json:"label"`   // human description for the dropdown
	Kind    string `json:"kind"`    // "sink" | "source" | "app"
	Default bool   `json:"default"` // the current default sink/source
}

// Source is one channel of a capture plan: a physical endpoint bound to a fixed
// speaker label and interleave position. A meeting captures 1..N of them.
type Source struct {
	// Target is the capture handle the audio adapter binds (PipeWire
	// object.serial, or a device name for PulseAudio).
	Target string
	// Name is the human-readable endpoint name, for logging/UI.
	Name string
	// Origin classifies the channel (mic/system/line).
	Origin Origin
	// Speaker is the label attributed to everything on this channel when the
	// engine does not diarize it (e.g. a dedicated mic = one known person).
	// Empty means "let the engine diarize this channel".
	Speaker string
	// Channel is this source's interleave index (0..N-1) in a multichannel
	// stream, assigned by CapturePlan order.
	Channel int
}

// CapturePlan is the resolved set of sources for a meeting plus the engine and
// languages to transcribe them with. Everything downstream works for any N, so
// two mics + system or a single mixed source are the same code path.
type CapturePlan struct {
	Sources   []Source
	Provider  ProviderID
	Languages []Language
}

// Channels reports how many source channels the plan carries.
func (p CapturePlan) Channels() int { return len(p.Sources) }

// PrimaryLanguage returns the first configured language, or DefaultLanguage.
func (p CapturePlan) PrimaryLanguage() Language {
	if len(p.Languages) > 0 && p.Languages[0] != "" {
		return p.Languages[0]
	}
	return DefaultLanguage
}
