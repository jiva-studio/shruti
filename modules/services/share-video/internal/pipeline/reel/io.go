package reel

import "os"

// osReadFile is the indirection underneath font.go's readFile var.
// Lifted to its own file so tests can stub readFile without touching
// the production code path.
func osReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}
