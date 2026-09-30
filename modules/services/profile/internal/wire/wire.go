// Package wire holds the hand-authored sync wire contract — the Go side of
// the structs mirrored on the mobile/web clients as TypeScript *Wire types
// (@lib/contracts/sync). snake_case JSON on the wire; `data` is an opaque
// JSON blob to the transport. These must not drift from the TS side. The
// error, probe and purge bodies every route answers with live here too.
package wire

import "encoding/json"

// Change is a single change-log row. ServerSeq is set on pull rows and on
// conflict masters.
type Change struct {
	ServerSeq  int64           `json:"server_seq,omitempty"` // pull rows and conflict masters
	Collection string          `json:"collection"`
	DocID      string          `json:"doc_id"`
	Op         string          `json:"op"`             // "upsert" | "delete"
	Data       json.RawMessage `json:"data,omitempty"` // null on delete
	HLC        string          `json:"hlc"`
}

// PullRequest asks for changes since Cursor, up to Limit (server-clamped).
type PullRequest struct {
	Cursor int64 `json:"cursor"`
	Limit  int   `json:"limit"`
}

// PullResponse returns changes ordered by global_seq, the advanced cursor,
// and whether another page remains.
type PullResponse struct {
	Changes []Change `json:"changes"`
	Cursor  int64    `json:"cursor"`
	HasMore bool     `json:"has_more"`
}

// PushItem is one local change offered to the server. BaseHLC is the
// last-seen server hlc for optimistic concurrency; "" means a new doc.
type PushItem struct {
	Collection string          `json:"collection"`
	DocID      string          `json:"doc_id"`
	Op         string          `json:"op"`
	Data       json.RawMessage `json:"data,omitempty"`
	HLC        string          `json:"hlc"`
	BaseHLC    string          `json:"base_hlc,omitempty"`
}

// PushRequest is a batch of local changes stamped with the writing device.
type PushRequest struct {
	DeviceID string     `json:"device_id"`
	Changes  []PushItem `json:"changes"`
}

// Ref identifies a document by (collection, doc_id).
type Ref struct {
	Collection string `json:"collection"`
	DocID      string `json:"doc_id"`
}

// Conflict reports a stale-base push back to the client with the master row
// to re-merge against.
type Conflict struct {
	Collection string `json:"collection"`
	DocID      string `json:"doc_id"`
	Master     Change `json:"master"`
}

// PushResponse — no cursor field: the pull cursor advances only via pull.
type PushResponse struct {
	Applied   []Ref      `json:"applied"`
	Conflicts []Conflict `json:"conflicts"`
}

// CursorRequest acknowledges the highest applied global_seq for a device.
type CursorRequest struct {
	DeviceID string `json:"device_id"`
	AckedSeq int64  `json:"acked_seq"`
}

// OKResponse acknowledges a cursor ack or a purge.
type OKResponse struct {
	OK bool `json:"ok"`
}

// PurgeRequest names the user /internal/purge erases.
type PurgeRequest struct {
	UserID string `json:"user_id"`
}

// ErrorResponse is every error body: {"error":{"code","message"}}.
type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

// ErrorBody carries a stable machine-readable code and a human message.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// HealthResponse answers /healthz with the running image's build.
type HealthResponse struct {
	Build  Build  `json:"build"`
	Status string `json:"status"`
}

// Build identifies the image: its commit and build time.
type Build struct {
	SHA  string `json:"sha"`
	Time string `json:"time"`
}

// ReadyResponse answers /readyz once the schema is current.
type ReadyResponse struct {
	Status string `json:"status"`
}
