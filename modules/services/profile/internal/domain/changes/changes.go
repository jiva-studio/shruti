// Package changes is the vocabulary of profile's sync substrate: a change-log
// row, the collections a change may address, and the faults a caller can
// commit when offering one.
//
// The substrate holds no business rules about the content of the data; all
// merge logic runs on the client. The server only detects a stale base and
// hands the master back as a conflict.
package changes

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Ops a change carries.
const (
	OpUpsert = "upsert"
	OpDelete = "delete"
)

// LibraryItems is the server-owned Personal Library collection.
const LibraryItems = "library_items"

// Change is one change-log row. ServerSeq is the global_seq the log assigned
// it, zero for a change not yet written. Data is null on a delete.
type Change struct {
	ServerSeq  int64
	Collection string
	DocID      string
	Op         string
	Data       json.RawMessage
	HLC        string
}

// Ref identifies a document by (collection, doc_id).
type Ref struct {
	Collection string
	DocID      string
}

// Conflict is a stale-base push handed back with the master row to re-merge
// against.
type Conflict struct {
	Collection string
	DocID      string
	Master     Change
}

// collections is the whitelist of syncable collections; each maps 1:1 to a
// typed state table.
//
// library_items is server-owned: written only by the server, pulled but never
// pushed by clients. library_memberships is its client-owned companion — the
// user's remove/re-add intent — pushed and merged like playlist_items.
var collections = map[string]bool{
	"playlist_items":      true,
	"listening_sessions":  true,
	"notes":               true,
	"chat_sessions":       true,
	"chat_messages":       true,
	LibraryItems:          true,
	"library_memberships": true,
}

// serverOwned is the subset of collections authored only by the server and
// pull-only for clients. Every key here is also in collections.
var serverOwned = map[string]bool{
	LibraryItems: true,
}

// IsKnown reports whether collection is syncable.
func IsKnown(collection string) bool { return collections[collection] }

// IsServerOwned reports whether collection is authored only by the server.
func IsServerOwned(collection string) bool { return serverOwned[collection] }

// ErrNotProjected is returned for a publish flip whose track has no library
// membership, so there is nothing to flip.
var ErrNotProjected = errors.New("library item not projected")

// ValidationError is a caller fault — a malformed request the client must fix.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// BadRequest builds a ValidationError.
func BadRequest(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// IsValidation reports whether err is a ValidationError.
func IsValidation(err error) bool {
	var v *ValidationError
	return errors.As(err, &v)
}

// ForbiddenError is a caller fault — an operation the client may not perform,
// such as pushing a server-owned collection. Code is a stable machine-readable
// slug surfaced to the client.
type ForbiddenError struct {
	Code string
	Msg  string
}

func (e *ForbiddenError) Error() string { return e.Msg }

// Forbidden builds a ForbiddenError.
func Forbidden(code, format string, args ...any) error {
	return &ForbiddenError{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// AsForbidden reports whether err is a ForbiddenError and returns it.
func AsForbidden(err error) (*ForbiddenError, bool) {
	var f *ForbiddenError
	ok := errors.As(err, &f)
	return f, ok
}

// PublishedData merges origin='published' (and track_id when absent) into a
// library_items master's data, keeping the ready-time metadata that the
// replace-all upsert would otherwise null. base may be empty.
func PublishedData(base json.RawMessage, trackID string) (json.RawMessage, error) {
	data := map[string]json.RawMessage{}
	if len(base) > 0 {
		if err := json.Unmarshal(base, &data); err != nil {
			return nil, fmt.Errorf("decode master data: %w", err)
		}
	}
	data["origin"] = json.RawMessage(`"published"`)
	if _, ok := data["track_id"]; !ok {
		tid, err := json.Marshal(trackID)
		if err != nil {
			return nil, err
		}
		data["track_id"] = tid
	}
	return json.Marshal(data)
}
