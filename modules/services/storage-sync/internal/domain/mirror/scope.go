package mirror

import (
	"fmt"
	"path"
	"strings"
)

// Listed is one object as the mirror's bucket listing reports it.
type Listed struct {
	Key  string
	Size int64
}

// Verdict is what a full pass does with one source object once it has read the
// mirror's listing.
type Verdict int

const (
	// Skip leaves the mirror copy as it is.
	Skip Verdict = iota
	// Transfer ships the object without reading anything more from the mirror.
	Transfer
	// Inspect reads the mirror's checksum stamp and lets NeedsTransfer decide.
	Inspect
)

// Held is what a pass knows about the mirror's copy of a key without reading
// it: whether and at what size the listing shows it, and the checksum it was
// last seen or written with (empty when unknown).
type Held struct {
	Listed bool
	Size   int64
	SHA256 string
}

// CompareListed decides without a request to the mirror whenever it can: an
// object absent from the listing, listed with another size, or known to hold
// another checksum, ships. Otherwise the listing cannot tell, so the object is
// inspected when verifyChecksum is set and skipped when not.
func CompareListed(src Object, dst Held, verifyChecksum bool) Verdict {
	if !dst.Listed || dst.Size != src.Size {
		return Transfer
	}
	if dst.SHA256 != "" && dst.SHA256 != src.SHA256 {
		return Transfer
	}
	if verifyChecksum {
		return Inspect
	}
	return Skip
}

// Scope says which keys a pass leaves alone and which it compares by checksum
// on every pass.
//
// Excluded keys are matched by prefix and are invisible to a pass in both
// directions: never shipped, never pruned. Mutable keys are matched with
// path.Match patterns; they name objects rewritten in place, whose content can
// change while the size stays the same.
type Scope struct {
	exclude []string
	mutable []string
}

// NewScope builds a Scope, refusing a malformed pattern and any entry with a
// leading slash (keys never start with one), so a typo fails at startup.
func NewScope(excludePrefixes, mutablePatterns []string) (Scope, error) {
	s := Scope{}
	for _, p := range excludePrefixes {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if err := ValidateKeyPattern(p); err != nil {
			return Scope{}, fmt.Errorf("exclude prefix: %w", err)
		}
		s.exclude = append(s.exclude, p)
	}
	for _, p := range mutablePatterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if err := ValidateKeyPattern(p); err != nil {
			return Scope{}, fmt.Errorf("mutable key pattern: %w", err)
		}
		s.mutable = append(s.mutable, p)
	}
	return s, nil
}

// ValidateKeyPattern refuses a pattern that cannot match a stored key: one
// with a leading slash, or one path.Match cannot parse.
func ValidateKeyPattern(p string) error {
	if strings.HasPrefix(p, "/") {
		return fmt.Errorf("%q starts with a slash; keys do not", p)
	}
	if _, err := path.Match(p, ""); err != nil {
		return fmt.Errorf("%q: %w", p, err)
	}
	return nil
}

// IsExcluded reports whether key falls under an excluded prefix.
func (s Scope) IsExcluded(key string) bool {
	for _, p := range s.exclude {
		if strings.HasPrefix(key, p) {
			return true
		}
	}
	return false
}

// IsMutable reports whether key matches a mutable pattern.
func (s Scope) IsMutable(key string) bool {
	for _, p := range s.mutable {
		if ok, err := path.Match(p, key); ok || err != nil {
			return true
		}
	}
	return false
}
