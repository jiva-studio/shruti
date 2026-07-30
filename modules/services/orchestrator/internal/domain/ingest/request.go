package ingest

import "encoding/json"

// Request is the decoded `ingest.request` broker message: a user's request to
// ingest a lecture into their private library. It is produced by chat and
// consumed by the orchestrator. Token carries the caller's access JWT so the
// orchestrator can RE-VERIFY the PRO entitlement at processing time (the tier
// may have lapsed between enqueue and dispatch); UserID is advisory — the
// authoritative id is the verified token subject.
type Request struct {
	RequestID string `json:"request_id,omitempty"`
	URL       string `json:"url"`
	Kind      string `json:"kind,omitempty"`
	Token     string `json:"token"`
	UserID    string `json:"user_id,omitempty"`
	Title     string `json:"title,omitempty"`
	Author    string `json:"author,omitempty"`
}

// DecodeRequest parses a broker payload into a Request.
func DecodeRequest(b []byte) (Request, error) {
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return Request{}, err
	}
	return r, nil
}
