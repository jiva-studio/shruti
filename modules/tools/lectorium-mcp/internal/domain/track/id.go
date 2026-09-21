// Package track models a track: its identity, audio, metadata and selectors.
package track

import (
	"fmt"
	"regexp"
)

// ID is the opaque track identifier with the canonical Lectorium shape:
// "track_" prefix + 12 chars from [A-Za-z0-9].
type ID string

var idPattern = regexp.MustCompile(`^track_[A-Za-z0-9]{12}$`)

func NewID(raw string) (ID, error) {
	if !idPattern.MatchString(raw) {
		return "", fmt.Errorf("invalid track id %q: expected track_<12 alnum>", raw)
	}
	return ID(raw), nil
}

func (id ID) String() string { return string(id) }
