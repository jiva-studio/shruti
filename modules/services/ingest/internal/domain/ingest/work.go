package ingest

import "encoding/json"

// WorkCommand is the decoded `ingest.work` broker message: the orchestrator's
// dispatch of one ingest job to the stateless ingest worker. It carries the
// job id (the worker echoes it back on every result so the orchestrator can
// correlate), the source URL to fetch, the caller-supplied title, the owner id
// (advisory — surfaced back on results), and the attempt counter (owned by the
// orchestrator's retry policy; the worker never increments it).
type WorkCommand struct {
	JobID string `json:"job_id"`
	// RequestID is the chat turn's trace_id, carried unchanged from the user's
	// original request so the worker's logs join the same correlation chain.
	RequestID string `json:"request_id,omitempty"`
	URL       string `json:"url"`
	Title     string `json:"title,omitempty"`
	Author    string `json:"author,omitempty"`
	OwnerID   string `json:"owner_id,omitempty"`
	Attempt   int    `json:"attempt"`
	// TranslateLangs requests full translated variants (title + overview +
	// transcript) for these languages when they were not spoken in the
	// recording. Empty translates nothing.
	TranslateLangs []string `json:"translate_langs,omitempty"`
	// Op selects the worker branch ("ingest" | "translate"); empty means ingest.
	// MembershipID links the run to the track projection it advances.
	Op           string `json:"op,omitempty"`
	MembershipID string `json:"membership_id,omitempty"`
	// Translate-op fields: the already-ingested track to translate, its source
	// language (which stored transcript to read), and the target language.
	Track      string `json:"track,omitempty"`
	SourceLang string `json:"source_lang,omitempty"`
	TargetLang string `json:"target_lang,omitempty"`
}

// DecodeWork parses a broker payload into a WorkCommand.
func DecodeWork(b []byte) (WorkCommand, error) {
	var w WorkCommand
	if err := json.Unmarshal(b, &w); err != nil {
		return WorkCommand{}, err
	}
	return w, nil
}
