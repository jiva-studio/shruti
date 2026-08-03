// Package assets defines what the asset-sync use case needs from the outside:
// somewhere to put bytes (an s3port.Uploader) and a rule for deciding whether a
// given file needs putting at all.
//
// The catalog publish step ships only the catalog DB and config.json; the audio
// and transcripts under out/public/ used to ride a separate `aws s3 sync`, which
// stopped being an option when the publish target moved to Bunny. Sync fills
// that gap without inventing a second uploader.
package assets

import (
	"context"

	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

// File is one local asset the sync considers.
type File struct {
	// Key is the bucket-relative path, forward slashes, no leading slash —
	// the same key the mobile app resolves against the CDN.
	Key  string
	Path string // absolute path on disk
	Size int64
}

// Decider answers whether a local file has to be uploaded. Implementations
// differ in how much they trust the remote side: presence alone, presence plus
// size, or nothing at all.
//
// Reason is surfaced in the run report so a sync that uploads more than
// expected can be explained without re-running it.
type Decider interface {
	Name() string
	Needs(ctx context.Context, target s3port.Uploader, f File) (need bool, reason string, err error)
}
