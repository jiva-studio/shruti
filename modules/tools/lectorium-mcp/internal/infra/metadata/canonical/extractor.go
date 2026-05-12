package canonical

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	metaport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/metadata"
)

// ChainExtractor parses dedup-canonical filenames without calling the LLM
// and falls back to `Fallback` for anything else (legacy lake files,
// non-canonical names). It is a drop-in metaport.Extractor so the
// extractmeta usecase doesn't need to know which path was taken.
type ChainExtractor struct {
	// InDir is the lake root used to reconstruct an absolute-ish path from
	// the relPath the usecase hands us. Required for path-pattern matching.
	InDir    string
	Fallback metaport.Extractor
}

func (c ChainExtractor) Name() string {
	if c.Fallback != nil {
		return "canonical|" + c.Fallback.Name()
	}
	return "canonical"
}

func (c ChainExtractor) Extract(ctx context.Context, relPath string, sourceCodes []string) (track.Metadata, error) {
	full := relPath
	if c.InDir != "" {
		full = filepath.Join(c.InDir, relPath)
	}
	if spec, ok := Parse(full); ok {
		if strings.TrimSpace(spec.Title) == "" {
			spec.Title = fallbackTitle(filepath.Base(relPath))
			spec.TitleIsFallback = true
		}
		return track.NewMetadata(spec)
	}
	if c.Fallback == nil {
		return track.Metadata{}, fmt.Errorf("canonical: path not in outbox/sorted layout and no fallback extractor configured")
	}
	return c.Fallback.Extract(ctx, relPath, sourceCodes)
}

// fallbackTitle mirrors the LLM extractor's fallback so commit-stage error
// messages stay consistent across both paths.
func fallbackTitle(filename string) string {
	t := strings.TrimSuffix(filename, ".mp3")
	t = strings.TrimSuffix(t, ".MP3")
	return strings.TrimSpace(t)
}

var _ metaport.Extractor = (*ChainExtractor)(nil)
