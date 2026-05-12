// Package fsport carries small filesystem-shape ports used by use cases
// instead of calling os.* directly — keeps the application layer
// unit-testable without temp files.
package fsport

import "context"

// Existence reports whether a file path exists. The error return is
// reserved for unexpected I/O errors (permission denied, etc.) — a plain
// "not found" should map to (false, nil).
type Existence interface {
	Exists(ctx context.Context, path string) (bool, error)
}

// Stat returns size + mtime + an existence flag for a path.
type Stat interface {
	Stat(ctx context.Context, path string) (StatInfo, bool, error)
}

type StatInfo struct {
	SizeBytes int64
	ModTimeMs int64
}
