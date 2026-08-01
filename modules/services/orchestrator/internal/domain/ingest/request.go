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
	// TranslateLangs opts the track into full translated variants (title +
	// overview + transcript) for these languages when they were not spoken in
	// the recording. Empty (the default) translates nothing — the track keeps
	// only its detected-language variants.
	TranslateLangs []string `json:"translate_langs,omitempty"`
	// Op selects the run operation ("ingest" | "translate"); empty means ingest.
	Op string `json:"op,omitempty"`
	// The fields below drive op="translate": the already-ingested track's
	// membership (the id its library row keys on, = the ingest run id), the
	// content hash, the source language to translate FROM and the target language.
	MembershipID string `json:"membership_id,omitempty"`
	Track        string `json:"track,omitempty"`
	SourceLang   string `json:"source_lang,omitempty"`
	TargetLang   string `json:"target_lang,omitempty"`
}

// DecodeRequest parses a broker payload into a Request.
func DecodeRequest(b []byte) (Request, error) {
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return Request{}, err
	}
	return r, nil
}
