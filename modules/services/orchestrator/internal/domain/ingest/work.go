// Package ingest holds the orchestrator's personal-library ingest domain — the
// kind-specific wire contract behind a `library_ingest` job. It stays
// dependency-light (stdlib only) so the generic job aggregate and the ports
// layer can reference it freely.
//
// The orchestrator is a thin COORDINATOR: it decodes an `ingest.request`
// (request.go), dispatches an `ingest.work` command (WorkCommand, below) to the
// stateless ingest worker, decodes the worker's `ingest.result` (result.go),
// and drives the `track.events` lifecycle (event.go). The heavy
// fetch/transcribe/store work lives in the separate `ingest` service.
package ingest

import "encoding/json"

// WorkCommand is the orchestrator's dispatch to the ingest worker, marshalled
// into an `ingest.work` outbox row (topic "ingest.work"). JobID lets the worker
// echo the correlation on every result; Attempt is owned by the orchestrator's
// retry policy (the worker never increments it — it only reports outcomes).
type WorkCommand struct {
	JobID string `json:"job_id"`
	// RequestID is the chat turn's trace_id, carried from the originating
	// `ingest.request` so the worker's logs join the same correlation chain.
	RequestID string `json:"request_id,omitempty"`
	URL       string `json:"url"`
	Title     string `json:"title,omitempty"`
	Author    string `json:"author,omitempty"`
	OwnerID   string `json:"owner_id,omitempty"`
	Attempt   int    `json:"attempt"`
}

// Marshal serializes the command for the `ingest.work` outbox payload column.
func (w WorkCommand) Marshal() ([]byte, error) { return json.Marshal(w) }
