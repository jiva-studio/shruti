// Package gatefixturealias is a known violation: the application layer reaches
// the Postgres driver through an internal package that re-exports it.
package gatefixturealias

import "github.com/jiva-studio/shruti/orchestrator/internal/gatefixture_pgxalias"

// Fixture exposes the re-exported driver type so the import is used.
type Fixture = gatefixturepgxalias.Conn
