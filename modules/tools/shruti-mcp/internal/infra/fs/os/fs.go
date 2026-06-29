// Package osfs implements fsport.Existence and fsport.Stat against the
// host filesystem.
package osfs

import (
	"context"
	"errors"
	"io/fs"
	"os"

	fsport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/fs"
)

type FS struct{}

func New() FS { return FS{} }

func (FS) Exists(ctx context.Context, path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func (FS) Stat(ctx context.Context, path string) (fsport.StatInfo, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fsport.StatInfo{}, false, nil
		}
		return fsport.StatInfo{}, false, err
	}
	return fsport.StatInfo{
		SizeBytes: info.Size(),
		ModTimeMs: info.ModTime().UnixMilli(),
	}, true, nil
}

var (
	_ fsport.Existence = (*FS)(nil)
	_ fsport.Stat      = (*FS)(nil)
)
