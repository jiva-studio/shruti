package ingest

import "encoding/json"

// WorkCommand is the decoded `ingest.work` broker message: the orchestrator's
// dispatch of one ingest job to the stateless ingest worker. It carries the
// job id (the worker echoes it back on every result so the orchestrator can
// correlate), the source URL to fetch, the caller-supplied title, the owner id
// (advisory — surfaced back on results), and the attempt counter (owned by the
// orchestrator's retry policy; the worker never increments it).
type WorkCommand struct {
	JobID   string `json:"job_id"`
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	OwnerID string `json:"owner_id,omitempty"`
	Attempt int    `json:"attempt"`
}

// DecodeWork parses a broker payload into a WorkCommand.
func DecodeWork(b []byte) (WorkCommand, error) {
	var w WorkCommand
	if err := json.Unmarshal(b, &w); err != nil {
		return WorkCommand{}, err
	}
	return w, nil
}
