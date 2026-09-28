//go:build prod

// Package gatefixtureprodtag is a known violation: a file behind a build tag
// the linters are not run with, so no layer rule reads its imports.
package gatefixtureprodtag

import "github.com/jackc/pgx/v5"

// Fixture exposes the driver type so the import is used.
type Fixture = pgx.Conn
