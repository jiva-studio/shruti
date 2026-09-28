// Package gatefixturepgxalias re-exports the Postgres driver under a local
// name; it supports the gatefixture_alias fixture.
package gatefixturepgxalias

import "github.com/jackc/pgx/v5"

// Conn is the driver's connection under another package's name.
type Conn = pgx.Conn
