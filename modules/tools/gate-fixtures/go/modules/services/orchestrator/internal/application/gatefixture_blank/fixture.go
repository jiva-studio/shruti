// Package gatefixtureblank is a known violation: an error discarded with a
// blank assignment.
package gatefixtureblank

import "encoding/json"

// Fixture drops the error json.Unmarshal returns, so malformed input decodes
// to an empty value.
func Fixture(data []byte) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}
