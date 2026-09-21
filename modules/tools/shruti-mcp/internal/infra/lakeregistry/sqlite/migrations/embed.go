// Package migrations embeds the lake registry SQL migrations.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
