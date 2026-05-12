package review

import (
	"context"
	"fmt"

	reviewport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/review"
)

// chunkAttempt is the outcome of one chunk's review across all retry attempts.
// `final` carries the last ChunkResponse we observed (for debug even on failure);
// `err` is non-nil iff every attempt failed validation or transport.
type chunkAttempt struct {
	final    reviewport.ChunkResponse
	attempts int
	err      error
}

// tagOutcome returns a copy of the input models with the given outcome
// stamped on each entry that doesn't already have one. Existing
// outcomes are preserved (a retry-idx-mismatch entry that gets
// superseded keeps the more specific reason — the chain context is
// already implicit from the surrounding accepted entry's role/name).
// flags/note overlay regardless, since they describe THIS rejection.
func tagOutcome(models []reviewport.ModelEntry, outcome string, flags []string, note string) []reviewport.ModelEntry {
	if len(models) == 0 {
		return nil
	}
	out := make([]reviewport.ModelEntry, len(models))
	for i, m := range models {
		if m.Outcome == "" {
			m.Outcome = outcome
		}
		if len(flags) > 0 && len(m.AuditFlags) == 0 {
			m.AuditFlags = append([]string{}, flags...)
		}
		if note != "" && m.Note == "" {
			m.Note = note
		}
		out[i] = m
	}
	return out
}

func tryReview(ctx context.Context, r reviewport.Reviewer, req reviewport.ChunkRequest, retries int) chunkAttempt {
	expected := map[int]struct{}{}
	for _, s := range req.Segments {
		expected[s.Idx] = struct{}{}
	}
	var (
		last    reviewport.ChunkResponse
		hasResp bool
		lastErr error
		// rejected accumulates Models[] entries from retries that failed
		// validation or audit so their cost shows up in the artifact even
		// after a later retry succeeds.
		rejected []reviewport.ModelEntry
	)
	for attempt := 0; attempt <= retries; attempt++ {
		resp, err := r.ReviewChunk(ctx, req)
		if err != nil {
			// Transport error — no Models to record. Nothing was billed
			// for the failed request itself in our tracking.
			lastErr = err
			continue
		}
		last = resp
		hasResp = true
		if err := validateChunk(expected, resp.Segments); err != nil {
			lastErr = fmt.Errorf("idx-set mismatch")
			rejected = append(rejected, tagOutcome(resp.Models, reviewport.OutcomeRetryIdxMismatch, nil, "")...)
			continue
		}
		resp.AuditFlags = reviewport.DetectAuditFlags(req, resp)
		if reviewport.AnyCriticalAuditFlag(resp.AuditFlags) {
			lastErr = fmt.Errorf("audit gate failed: %v", resp.AuditFlags)
			rejected = append(rejected, tagOutcome(resp.Models, reviewport.OutcomeRetryAuditFailed, resp.AuditFlags, "")...)
			last = resp
			continue
		}
		// Successful call. Prepend the rejected retry entries so the
		// final Models[] reflects the full call history in order.
		resp.Models = append(append([]reviewport.ModelEntry{}, rejected...), resp.Models...)
		return chunkAttempt{final: resp, attempts: attempt + 1, err: nil}
	}
	if !hasResp {
		last = reviewport.ChunkResponse{}
	}
	// All retries exhausted. rejected already holds every retry's
	// tagged copy of resp.Models (one append per loop iteration that
	// failed validation/audit). Use it directly — last.Models is the
	// raw untagged copy of the final retry, already covered by the
	// rejected list.
	last.Models = append([]reviewport.ModelEntry{}, rejected...)
	return chunkAttempt{final: last, attempts: retries + 1, err: lastErr}
}

func validateChunk(expected map[int]struct{}, got []reviewport.ChunkSegment) error {
	if len(got) != len(expected) {
		return fmt.Errorf("count mismatch: got %d want %d", len(got), len(expected))
	}
	seen := map[int]struct{}{}
	for _, s := range got {
		if _, ok := expected[s.Idx]; !ok {
			return fmt.Errorf("unknown idx %d", s.Idx)
		}
		if _, dup := seen[s.Idx]; dup {
			return fmt.Errorf("duplicate idx %d", s.Idx)
		}
		seen[s.Idx] = struct{}{}
	}
	return nil
}
