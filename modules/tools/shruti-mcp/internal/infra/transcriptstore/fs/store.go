package fstranscript

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/transcript"
	fsartifact "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/artifact/fs"
	transcriptport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

type Store struct {
	OutDir string
	// art writes the private transcript artifacts (raw/review/chunk) to the lake
	// AND uploads them to S3 in one call. The public reviewed transcript stays on
	// the local-only path below (it rides the full sync / publish, not this).
	art *fsartifact.Writer
}

func New(outDir string, art *fsartifact.Writer) *Store {
	return &Store{OutDir: outDir, art: art}
}

// Provider-agnostic filename: today the bytes come from Parakeet, yesterday
// Whisper, tomorrow whatever. The on-disk shape is what matters, not the engine.
// The *Key funcs return the forward-slash relative artifact key (lake path and
// S3 object key are the same under OutDir); the *Path funcs are the absolute
// lake paths used for reads.
func (s *Store) rawKey(id track.Id, lang string) string {
	return fmt.Sprintf("artifacts/tracks/%s/transcripts/%s/raw.json", string(id), lang)
}

func (s *Store) reviewSessionKey(id track.Id, lang string) string {
	return fmt.Sprintf("artifacts/tracks/%s/transcripts/%s/review.json", string(id), lang)
}

func (s *Store) reviewChunkKey(id track.Id, lang string, chunkIndex int) string {
	return fmt.Sprintf("artifacts/tracks/%s/transcripts/%s/chunk_%04d.json", string(id), lang, chunkIndex)
}

func (s *Store) rawPath(id track.Id, lang string) string {
	return filepath.Join(s.OutDir, filepath.FromSlash(s.rawKey(id, lang)))
}

func (s *Store) reviewSessionPath(id track.Id, lang string) string {
	return filepath.Join(s.OutDir, filepath.FromSlash(s.reviewSessionKey(id, lang)))
}

func (s *Store) reviewChunkPath(id track.Id, lang string, chunkIndex int) string {
	return filepath.Join(s.OutDir, filepath.FromSlash(s.reviewChunkKey(id, lang, chunkIndex)))
}

func (s *Store) PublicTranscriptPath(id track.Id, lang string) string {
	return filepath.Join(s.OutDir, "public", "tracks", string(id), "transcripts", lang+".json")
}

// PublicTranscriptKey returns the rsync-bound key (no leading /).
func (s *Store) PublicTranscriptKey(id track.Id, lang string) string {
	return fmt.Sprintf("public/tracks/%s/transcripts/%s.json", string(id), lang)
}

func (s *Store) WriteRaw(ctx context.Context, id track.Id, lang string, raw transcript.Raw) error {
	body, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return s.art.Write(ctx, s.rawKey(id, lang), body)
}

func (s *Store) ReadRaw(ctx context.Context, id track.Id, lang string) (transcript.Raw, error) {
	body, err := os.ReadFile(s.rawPath(id, lang))
	if err != nil {
		return transcript.Raw{}, err
	}
	var raw transcript.Raw
	if err := json.Unmarshal(body, &raw); err != nil {
		return transcript.Raw{}, err
	}
	return raw, nil
}

func (s *Store) WriteReviewSession(ctx context.Context, id track.Id, lang string, sessionJSON []byte) error {
	return s.art.Write(ctx, s.reviewSessionKey(id, lang), sessionJSON)
}

func (s *Store) ReadReviewSession(ctx context.Context, id track.Id, lang string) ([]byte, error) {
	return os.ReadFile(s.reviewSessionPath(id, lang))
}

func (s *Store) WriteReviewChunk(ctx context.Context, id track.Id, lang string, chunkIndex int, chunkJSON []byte) error {
	return s.art.Write(ctx, s.reviewChunkKey(id, lang, chunkIndex), chunkJSON)
}

func (s *Store) ReadReviewChunk(ctx context.Context, id track.Id, lang string, chunkIndex int) ([]byte, error) {
	return os.ReadFile(s.reviewChunkPath(id, lang, chunkIndex))
}

func (s *Store) WriteReviewed(ctx context.Context, t transcript.Reviewed) error {
	id, err := track.NewId(t.TrackId)
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(s.PublicTranscriptPath(id, t.Language), body)
}

func (s *Store) ReadReviewed(ctx context.Context, id track.Id, lang string) (transcript.Reviewed, error) {
	body, err := os.ReadFile(s.PublicTranscriptPath(id, lang))
	if err != nil {
		return transcript.Reviewed{}, err
	}
	var r transcript.Reviewed
	if err := json.Unmarshal(body, &r); err != nil {
		return transcript.Reviewed{}, err
	}
	return r, nil
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
	return os.Rename(tmp.Name(), path)
}

var _ transcriptport.Store = (*Store)(nil)
