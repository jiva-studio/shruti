// Package module github.com/jiva-studio/shruti/catalogdb owns the published
// catalog (current.db) and library (library.db) SQLite formats: their
// canonical DDL, the ordered migrations that bring an older file up to it,
// the published scheme number, and typed read queries. Services and tools
// import it through a `replace` directive, as they import libs/pipeline.
module github.com/jiva-studio/shruti/catalogdb

go 1.25.5

require (
	github.com/mattn/go-sqlite3 v1.14.44
	golang.org/x/text v0.41.0
	modernc.org/sqlite v1.38.0
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/exp v0.0.0-20250408133849-7e4ce0ab07d0 // indirect
	golang.org/x/sys v0.33.0 // indirect
	modernc.org/libc v1.65.10 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)
