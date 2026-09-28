// Package assethashes rebuilds the catalog's transcript hashes from the files
// under out/: the chat indexer reads asset_hashes from the published catalog
// to discover and diff transcripts, since the CDN offers no listing.
package assethashes

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	fsport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/fs"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/hashing"
)

// Catalog is the part of the catalog the backfill reads and writes.
type Catalog interface {
	TranscriptVariants(ctx context.Context) ([]catalog.TranscriptAsset, error)
	UpsertTranscriptHashes(ctx context.Context, assets []catalog.TranscriptAsset) error
}

// UseCase hashes every transcript a variant points at and records the hashes.
// It is idempotent; a transcript missing under OutDir is counted and skipped.
type UseCase struct {
	Catalog Catalog
	Files   fsport.Existence
	Hasher  hashing.Hasher
	OutDir  string
}

// Result counts what one run did.
type Result struct {
	Variants int `json:"variants"`
	Hashed   int `json:"hashed"`
	Missing  int `json:"missing"`
}

func (uc UseCase) Run(ctx context.Context) (Result, error) {
	variants, err := uc.Catalog.TranscriptVariants(ctx)
	if err != nil {
		return Result{}, err
	}
	res := Result{Variants: len(variants)}
	hashed := make([]catalog.TranscriptAsset, 0, len(variants))
	for _, v := range variants {
		path := filepath.Join(uc.OutDir, filepath.FromSlash(v.Path))
		ok, err := uc.Files.Exists(ctx, path)
		if err != nil {
			return Result{}, fmt.Errorf("check %s: %w", v.Path, err)
		}
		if !ok {
			res.Missing++
			continue
		}
		if v.SHA256, err = uc.Hasher.HashFile(ctx, path); err != nil {
			return Result{}, fmt.Errorf("hash %s: %w", v.Path, err)
		}
		hashed = append(hashed, v)
	}
	if err := uc.Catalog.UpsertTranscriptHashes(ctx, hashed); err != nil {
		return Result{}, err
	}
	res.Hashed = len(hashed)
	return res, nil
}
