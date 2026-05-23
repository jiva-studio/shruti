package pipeline

import (
	"bytes"
	"io"
)

// copyAll is io.Copy with no return-byte count. Kept here so render.go
// reads tightly.
func copyAll(dst io.Writer, src io.Reader) (int64, error) {
	return io.Copy(dst, src)
}

// bytesReader wraps a byte slice as an io.ReadSeeker (PutObject doesn't
// require Seek but the SDK probes for it).
func bytesReader(b []byte) *bytes.Reader {
	return bytes.NewReader(b)
}
