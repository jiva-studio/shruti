package fsaudio

import (
	"context"
	"errors"
	"fmt"
	"github.com/jiva-studio/lectorium/pipeline/blobpath"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/audio"
)

// Store implements audio.Store on top of the local filesystem rooted at outDir.
type Store struct {
	outDir string
}

func New(outDir string) *Store { return &Store{outDir: outDir} }

func (s *Store) SourceArtifactPath(id track.Id) string {
	return filepath.Join(s.outDir, "artifacts", "tracks", string(id), "audio", "source.mp3")
}

func (s *Store) PublicAudioPath(id track.Id, version audioport.Version) string {
	return filepath.Join(s.outDir, filepath.FromSlash(blobpath.AudioKey(string(id), string(version))))
}

// MoveSourceFromInput moves srcPath into the artifact path. On the same
// filesystem this is a free rename — input bytes simply re-key under the
// artifact location, so a 25 GB lake doesn't double on disk during ingest.
// On EXDEV (cross-device) we fall back to copy-then-remove so the contract
// "source is gone after this returns" still holds.
func (s *Store) MoveSourceFromInput(ctx context.Context, id track.Id, srcPath string) error {
	dst := s.SourceArtifactPath(id)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(dst), err)
	}
	if err := os.Rename(srcPath, dst); err == nil {
		return nil
	} else if !isCrossDevice(err) {
		return fmt.Errorf("rename %s → %s: %w", srcPath, dst, err)
	}
	// Cross-device: copy via tmp + atomic rename, then drop the source.
	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer src.Close()
	if err := atomicWrite(dst, src); err != nil {
		return err
	}
	if err := os.Remove(srcPath); err != nil {
		return fmt.Errorf("remove source after copy: %w", err)
	}
	return nil
}

func isCrossDevice(err error) bool {
	var le *os.LinkError
	if errors.As(err, &le) {
		return errors.Is(le.Err, syscall.EXDEV)
	}
	return errors.Is(err, syscall.EXDEV)
}

// TranscriptOriginalPDFPath is the home of the BBT/VedaBase-style typeset
// transcript that ships next to the source mp3 in the dedup-tool's outbox.
// Optional: not every track has one.
func (s *Store) TranscriptOriginalPDFPath(id track.Id) string {
	return filepath.Join(s.outDir, "artifacts", "tracks", string(id), "transcript.pdf")
}

func (s *Store) AdoptSiblingPDF(ctx context.Context, id track.Id, mp3SrcPath string) (bool, error) {
	if !strings.HasSuffix(strings.ToLower(mp3SrcPath), ".mp3") {
		return false, nil
	}
	pdfSrc := mp3SrcPath[:len(mp3SrcPath)-len(".mp3")] + ".pdf"
	if _, err := os.Stat(pdfSrc); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("stat sibling pdf: %w", err)
	}
	dst := s.TranscriptOriginalPDFPath(id)
	if _, err := os.Stat(dst); err == nil {
		// Already adopted on a prior ingest; leave the input as-is. We
		// don't pull a fresh copy because the artifact is the canonical
		// home now.
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false, fmt.Errorf("mkdir %s: %w", filepath.Dir(dst), err)
	}
	if err := os.Rename(pdfSrc, dst); err == nil {
		return true, nil
	} else if !isCrossDevice(err) {
		return false, fmt.Errorf("rename %s → %s: %w", pdfSrc, dst, err)
	}
	src, err := os.Open(pdfSrc)
	if err != nil {
		return false, fmt.Errorf("open sibling pdf: %w", err)
	}
	defer src.Close()
	if err := atomicWrite(dst, src); err != nil {
		return false, err
	}
	if err := os.Remove(pdfSrc); err != nil {
		return false, fmt.Errorf("remove sibling pdf after copy: %w", err)
	}
	return true, nil
}

func (s *Store) AtomicWritePublic(ctx context.Context, id track.Id, src io.Reader) error {
	return atomicWrite(s.PublicAudioPath(id, audioport.VersionOriginal), src)
}

func atomicWrite(dst string, src io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(dst), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		_ = os.Remove(tmpName) // no-op if rename succeeded
	}()
	if _, err := io.Copy(tmp, src); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("rename %s → %s: %w", tmpName, dst, err)
	}
	// fsync the directory so the rename is durable
	if d, err := os.Open(filepath.Dir(dst)); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
