// Package ids defines the port for minting entity ids.
package ids

// Minter generates a 12-char [A-Za-z0-9] tail. Caller prepends the kind prefix
// (track_, author_, location_, source_, tag_).
type Minter interface {
	MintTail() string
}
