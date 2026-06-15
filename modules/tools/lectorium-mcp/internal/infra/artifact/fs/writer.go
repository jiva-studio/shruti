// Package fsartifact is the one place private per-track artifacts are written:
// it persists the bytes to the local lake AND uploads them to every configured
// S3 target under the same key, in one call. It unifies what used to be five
// copies of an atomicWrite helper scattered across the transcript / metadata /
// outline stores.
//
// Scope: textual content artifacts under the private artifacts/ prefix
// (transcripts raw/review/chunk, extracted metadata, granular outline). It does
// NOT handle the published catalog DB (a separate publish step), runtime SQLite
// (lake/runs registries), public/ assets, or the large binary source.mp3 / PDF
// (those ride the full `aws s3 sync out/`).
package fsartifact

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	s3port "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

type Writer struct {
	OutDir string
	// Uploaders receive each artifact right after the lake write (AWS primary +
	// Yandex mirror). Empty/nil = lake-only (no S3 configured).
	Uploaders []s3port.Uploader
}

// New builds an artifact writer. Pass the publish S3 targets to upload every
// artifact to the private artifacts/ prefix as it's written; pass none for
// lake-only.
func New(outDir string, uploaders ...s3port.Uploader) *Writer {
	return &Writer{OutDir: outDir, Uploaders: uploaders}
}

// Write persists body to the lake at <OutDir>/<relKey> (atomic, durable) and
// then uploads it to every configured S3 target under the same relKey. relKey
// is a forward-slash relative key with no leading slash, e.g.
// "artifacts/tracks/<id>/transcripts/<lang>/raw.json". A failed upload returns
// an error after the lake write has already succeeded, so callers report a
// clean re-runnable per-track failure (the lake copy is durable either way).
func (w *Writer) Write(ctx context.Context, relKey string, body []byte) error {
	if err := atomicWrite(filepath.Join(w.OutDir, filepath.FromSlash(relKey)), body); err != nil {
		return err
	}
	for _, up := range w.Uploaders {
		if up == nil {
			continue
		}
		if err := up.Put(ctx, relKey, contentType(relKey), bytes.NewReader(body), int64(len(body))); err != nil {
			return fmt.Errorf("upload artifact %s to %s: %w", relKey, up.Name(), err)
		}
	}
	return nil
}

func contentType(relKey string) string {
	if strings.HasSuffix(relKey, ".json") {
		return "application/json"
	}
	return "application/octet-stream"
}

func atomicWrite(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := io.Copy(tmp, bytes.NewReader(body)); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
