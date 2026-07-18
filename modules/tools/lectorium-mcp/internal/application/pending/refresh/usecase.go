// Package refresh self-fetches the pending-promotion queue artifact
// (pending.db) from S3/CDN, mirroring the catalog refresh download→verify→swap
// flow (issue #1233). The offline admin MCP has no prod-DB access, so the
// promotion queue is delivered as a published SQLite artifact.
package refresh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/cdn"
	pendingport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/pending"
)

// DefaultKey is the CDN key the producer publishes the artifact under. Kept a
// single fixed key (not a versioned manifest entry like the catalog) because
// the queue is small, mutable, and always fetched whole.
const DefaultKey = "public/db/pending.db"

// UseCase downloads pending.db to out/artifacts/pending/, verifies it, and
// atomically swaps it into place.
type UseCase struct {
	OutDir   string
	CDN      cdn.Source
	Verifier pendingport.Verifier
	// Key overrides DefaultKey when set (tests / alternate producers).
	Key string
	// OpMutex serializes refresh against the pending consumer (approve's
	// MarkConsumed) so a swap never races an in-flight read. Optional.
	OpMutex *sync.Mutex
}

type Result struct {
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	SizeBytes int64 `json:"size_bytes"`
}

func (uc UseCase) key() string {
	if uc.Key != "" {
		return uc.Key
	}
	return DefaultKey
}

func (uc UseCase) dir() string  { return filepath.Join(uc.OutDir, "artifacts", "pending") }
func (uc UseCase) Path() string { return filepath.Join(uc.dir(), "pending.db") }

// Run downloads the artifact to a temp file, verifies it is a well-formed
// pending.db, and atomically renames it over the live file. The live file is
// only replaced after verification succeeds, so a bad download never corrupts
// a working queue.
func (uc UseCase) Run(ctx context.Context) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if err := os.MkdirAll(uc.dir(), 0o755); err != nil {
		return Result{}, err
	}

	body, err := uc.CDN.GetFile(ctx, uc.key())
	if err != nil {
		return Result{}, fmt.Errorf("fetch %s: %w", uc.key(), err)
	}
	defer body.Close()

	dst := uc.Path()
	tmp, err := os.CreateTemp(uc.dir(), "pending.db.tmp-*")
	if err != nil {
		return Result{}, err
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		_ = os.Remove(tmpName) // no-op after a successful rename
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), body)
	if err != nil {
		return Result{}, fmt.Errorf("write pending.db: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return Result{}, err
	}
	if err := tmp.Close(); err != nil {
		return Result{}, err
	}

	// Verify BEFORE swapping in — a truncated / HTML-error download fails here
	// and the live file is left untouched.
	if uc.Verifier != nil {
		if err := uc.Verifier.VerifyArtifact(ctx, tmpName); err != nil {
			return Result{}, fmt.Errorf("verify pending.db: %w", err)
		}
	}

	if err := os.Rename(tmpName, dst); err != nil {
		return Result{}, fmt.Errorf("swap pending.db: %w", err)
	}

	return Result{
		Path:      dst,
		SHA256:    hex.EncodeToString(h.Sum(nil)),
		SizeBytes: n,
	}, nil
}
