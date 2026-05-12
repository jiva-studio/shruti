package track

import (
	"fmt"
	"regexp"
)

// Id is the opaque track identifier with the canonical Shruti shape:
// "track_" prefix + 12 chars from [A-Za-z0-9].
type Id string

var idPattern = regexp.MustCompile(`^track_[A-Za-z0-9]{12}$`)

func NewId(raw string) (Id, error) {
	if !idPattern.MatchString(raw) {
		return "", fmt.Errorf("invalid track id %q: expected track_<12 alnum>", raw)
	}
	return Id(raw), nil
}

func (id Id) String() string { return string(id) }
