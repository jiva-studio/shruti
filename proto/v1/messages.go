// Package v1 is the shared wire contract for Shruti. It is the single source of
// truth for the message shapes exchanged between the client, the host WebSocket
// server (streamd), and the Swift ASR daemon (fluidstreamd).
//
// Two hops use these types:
//
//	client  ──WebSocket──▶  streamd   : binary frames = raw PCM (see Audio* consts);
//	                                     text frames  = Control (client→server).
//	streamd ◀──text frame──  streamd   : Update JSON (server→client), Channel set.
//
//	streamd ──stdin──▶  fluidstreamd    : raw PCM bytes only (one process per channel).
//	streamd ◀─stdout──  fluidstreamd    : NDJSON, one Update per line, Channel empty.
package v1

// Audio format used everywhere in the system: signed 16-bit little-endian PCM,
// mono, 16 kHz. Both capture (client) and ASR (host) assume exactly this.
const (
	SampleRate    = 16000 // Hz
	Channels      = 1
	BytesPerFrame = 2 // int16
)

// Update is a transcription update.
//
//   - fluidstreamd writes it to stdout as NDJSON (one object per line), with
//     Channel left empty — it does not know which channel it serves.
//   - streamd stamps Channel and relays it to the client as a WebSocket text frame.
type Update struct {
	Type    string `json:"type"`              // TypePartial | TypeFinal
	Channel string `json:"channel,omitempty"` // ChannelSystem | ChannelMic (set by streamd)
	Text    string `json:"text"`
	TsMs    int64  `json:"ts_ms"` // milliseconds since session start
}

// Update.Type values.
const (
	// TypePartial is a running hypothesis for the current utterance. It may be
	// revised (replaced) by later partials or a final for the same utterance.
	TypePartial = "partial"
	// TypeFinal is a committed, stable segment. It will not change.
	TypeFinal = "final"
)

// Update.Channel values — the two independently-captured audio sources.
const (
	ChannelSystem = "system" // everything the apps play (Zoom/browser/...): "они"
	ChannelMic    = "mic"     // the local microphone: "я"
)

// Control is a client→streamd text-frame message that steers a live session.
type Control struct {
	Type string `json:"type"` // CtrlFinalize | CtrlClose
}

// Control.Type values.
const (
	// CtrlFinalize asks the server to flush the current utterance and emit its
	// final, without ending the session.
	CtrlFinalize = "finalize"
	// CtrlClose ends the session; the server flushes, emits a last final, and
	// closes the connection.
	CtrlClose = "close"
)

// StreamPath is the WebSocket route on streamd. Query params:
//
//	channel      = system | mic   (required; echoed back on every Update)
//	sample_rate  = 16000          (optional; must match SampleRate if given)
//	lang         = ru | en | ...  (optional; ASR language hint)
const StreamPath = "/v1/stream"
