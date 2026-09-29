package pipeline

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func (r *Renderer) downloadSource(ctx context.Context, key, dst string) error {
	// Local mode: read the source from <LocalSourceDir>/<key> instead of the
	// store. key is validated at the API layer (public/tracks|shares/...mp3).
	if r.LocalSourceDir != "" {
		return copyFile(filepath.Join(r.LocalSourceDir, filepath.Clean("/"+key)), dst)
	}
	return r.Store.DownloadTo(ctx, key, dst)
}

func (r *Renderer) uploadOutput(ctx context.Context, localPath, key string) error {
	if r.LocalOutputDir != "" {
		dst := filepath.Join(r.LocalOutputDir, filepath.Clean("/"+key))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return copyFile(localPath, dst)
	}
	return r.Store.Put(ctx, key, localPath, "video/mp4")
}

func (r *Renderer) buildOutputURL(key string) string {
	if r.LocalOutputDir != "" {
		return "file://" + filepath.Join(r.LocalOutputDir, filepath.Clean("/"+key))
	}
	return strings.TrimRight(r.OutputPublicBase, "/") + "/" + key
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("copy %s: %w", dst, err)
	}
	return out.Close()
}
