package domain

// EventKind distinguishes a running hypothesis from a committed segment.
type EventKind string

const (
	// EventPartial is a running hypothesis; it may be revised by later events.
	EventPartial EventKind = "partial"
	// EventFinal is a committed, stable segment; it will not change.
	EventFinal EventKind = "final"
	// EventStatus reports engine/session state (e.g. the host degraded to a mixed
	// stream) rather than transcript content. It carries Mode/Reason, not Text.
	EventStatus EventKind = "status"
)

// TranscriptEvent is one live update from an engine, already mapped into domain
// vocabulary. The application turns finals into Utterances and streams every
// event to the UI. EventStatus events carry Mode/Reason instead of transcript.
type TranscriptEvent struct {
	Kind    EventKind
	Speaker string // diarization/attribution label ("Я", "Спикер 2", "Алиса"); "" if none
	Text    string
	Channel int   // source channel index this event came from (-1 if unknown)
	TsMs    int64 // milliseconds since session start

	// Status fields (set only when Kind == EventStatus).
	Mode   string // "mixed" | "multichannel"
	Reason string // e.g. "ane_capacity"
}
