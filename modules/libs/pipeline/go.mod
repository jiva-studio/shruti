// Package module github.com/jiva-studio/shruti/pipeline holds the pure,
// reusable transcribe/review/normalize pipeline pieces extracted from the
// shruti-mcp tool so future services (e.g. an orchestrator) can import
// them. Go's internal/ rule blocks cross-module import of mcp's internals;
// this module exposes the dependency-free domain types and stage port
// contracts with no lake/FS/catalog coupling.
module github.com/jiva-studio/shruti/pipeline

go 1.26.2
