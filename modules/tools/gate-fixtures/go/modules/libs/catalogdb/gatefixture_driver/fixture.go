// Package gatefixturedriver is a known violation: the catalog format library
// registers a SQLite driver of its own.
package gatefixturedriver

import sqlite3 "github.com/mattn/go-sqlite3"

// Fixture exposes the driver type so the import is used.
type Fixture = sqlite3.SQLiteDriver
