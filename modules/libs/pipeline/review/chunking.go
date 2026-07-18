// Package review holds the pure transcript-review ALGORITHM extracted from
// lectorium-mcp: chunk building, sentence-boundary voting/splitting, and the
// per-chunk retry/fallback logic. It has NO lake/FS/catalog coupling — it
// operates only on the module's own transcript domain types and stage port
// contracts, so an orchestrator (or any other service) can drive the review
// algorithm without importing mcp internals. The stateful, IO-bound bits
// (artifact persistence, aggregation, stage claiming) stay in mcp.
package review

import (
	"strings"

	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// JoinChunkText concatenates segment texts with single spaces — only
// used to feed the glossary matcher, which doesn't care about idx.
func JoinChunkText(segs []reviewport.ChunkSegment) string {
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

// Chunk is a contiguous window of raw segments produced by BuildChunks.
type Chunk struct {
	Segs []transcript.RawSegment
}

// BuildChunks splits all segments into overlapping windows of the given
// size. overlap is clamped to a sane range.
func BuildChunks(all []transcript.RawSegment, size, overlap int) []Chunk {
	if size <= 0 {
		size = 50
	}
	if overlap < 0 {
		overlap = 0
	}
	if overlap >= size {
		overlap = size / 4
	}
	var out []Chunk
	step := size - overlap
	for start := 0; start < len(all); start += step {
		end := start + size
		if end > len(all) {
			end = len(all)
		}
		out = append(out, Chunk{Segs: append([]transcript.RawSegment{}, all[start:end]...)})
		if end == len(all) {
			break
		}
	}
	return out
}

// LastN returns a copy of the last n elements of s (or all of s if n >= len).
func LastN[T any](s []T, n int) []T {
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

// MinInt returns the smaller of a and b.
func MinInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
