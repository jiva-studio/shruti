// Package gatefixturepgx is a known violation: the application layer names the
// Postgres driver.
package gatefixturepgx

import "github.com/jackc/pgx/v5"

// Fixture exposes the driver type so the import is used.
type Fixture = pgx.Conn
