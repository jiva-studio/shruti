package review

import (
	"testing"

	reviewport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/review"
)

func mkSeg(idx int, text string) reviewport.ChunkSegment {
	return reviewport.ChunkSegment{Idx: idx, Text: text}
}

func TestDetectAuditFlags_Clean(t *testing.T) {
	req := reviewport.ChunkRequest{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "First sentence."),
		mkSeg(1, "Second sentence with some words."),
		mkSeg(2, "Third one."),
	}}
	resp := reviewport.ChunkResponse{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "First sentence."),
		mkSeg(1, "Second sentence with some words."),
		mkSeg(2, "Third one."),
	}}
	if got := reviewport.DetectAuditFlags(req, resp); len(got) != 0 {
		t.Errorf("clean response should have no flags, got %v", got)
	}
}

// TestDetectAuditFlags_TrailingEmpty mirrors the live bug: pro returned
// valid idx-set but compacted content into the head of the chunk and
// padded the tail with empty segments. Detection must flag both
// empty_segments and all_shifted.
func TestDetectAuditFlags_TrailingEmpty(t *testing.T) {
	req := reviewport.ChunkRequest{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "Sentence A."),
		mkSeg(1, "Sentence B."),
		mkSeg(2, "Sentence C."),
		mkSeg(3, "Sentence D."),
		mkSeg(4, "Sentence E."),
	}}
	resp := reviewport.ChunkResponse{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "Sentence A. Sentence B."),
		mkSeg(1, "Sentence C. Sentence D. Sentence E."),
		mkSeg(2, ""),
		mkSeg(3, ""),
		mkSeg(4, ""),
	}}
	flags := reviewport.DetectAuditFlags(req, resp)
	if !contains(flags, reviewport.AuditEmptySegments) {
		t.Errorf("expected empty_segments, got %v", flags)
	}
	if !contains(flags, reviewport.AuditAllShifted) {
		t.Errorf("expected all_shifted, got %v", flags)
	}
}

func TestDetectAuditFlags_DrasticShrink(t *testing.T) {
	req := reviewport.ChunkRequest{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "This is a long sentence with many words and ideas."),
	}}
	resp := reviewport.ChunkResponse{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "Short."),
	}}
	flags := reviewport.DetectAuditFlags(req, resp)
	if !contains(flags, reviewport.AuditDrasticShrink) {
		t.Errorf("expected drastic_shrink, got %v", flags)
	}
}

func TestDetectAuditFlags_DrasticGrowth(t *testing.T) {
	req := reviewport.ChunkRequest{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "OK."),
	}}
	resp := reviewport.ChunkResponse{Segments: []reviewport.ChunkSegment{
		mkSeg(0, "OK is what was said but the model decided to expand the segment with many additional unrelated words."),
	}}
	flags := reviewport.DetectAuditFlags(req, resp)
	if !contains(flags, reviewport.AuditDrasticGrowth) {
		t.Errorf("expected drastic_growth, got %v", flags)
	}
}

func contains(slice []string, x string) bool {
	for _, s := range slice {
		if s == x {
			return true
		}
	}
	return false
}
