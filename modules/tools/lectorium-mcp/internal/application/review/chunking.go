package review

import (
	"strings"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/transcript"
	reviewport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/review"
)

// joinChunkText concatenates segment texts with single spaces — only
// used to feed the glossary matcher, which doesn't care about idx.
func joinChunkText(segs []reviewport.ChunkSegment) string {
	if len(segs) == 0 {
		return ""
	}
	parts := make([]string, 0, len(segs))
	for _, s := range segs {
		if t := strings.TrimSpace(s.Text); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

type chunk struct {
	segs []transcript.RawSegment
}

func buildChunks(all []transcript.RawSegment, size, overlap int) []chunk {
	if size <= 0 {
		size = 50
	}
	if overlap < 0 {
		overlap = 0
	}
	if overlap >= size {
		overlap = size / 4
	}
	var out []chunk
	step := size - overlap
	for start := 0; start < len(all); start += step {
		end := start + size
		if end > len(all) {
			end = len(all)
		}
		out = append(out, chunk{segs: append([]transcript.RawSegment{}, all[start:end]...)})
		if end == len(all) {
			break
		}
	}
	return out
}

func lastN[T any](s []T, n int) []T {
	if n <= 0 || len(s) == 0 {
		return nil
	}
	if n >= len(s) {
		out := make([]T, len(s))
		copy(out, s)
		return out
	}
	out := make([]T, n)
	copy(out, s[len(s)-n:])
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
