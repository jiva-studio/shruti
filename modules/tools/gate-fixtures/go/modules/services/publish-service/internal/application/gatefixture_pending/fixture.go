// Package gatefixturepending is a known violation: the application layer
// imports the pending.db writer instead of asking through a port.
package gatefixturepending

import "github.com/jiva-studio/shruti/publish/internal/pending"

// Fixture exposes the writer's row type so the import is used.
type Fixture = pending.Row
