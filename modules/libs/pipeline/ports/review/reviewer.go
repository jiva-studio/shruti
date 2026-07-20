package review

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// Reviewer reviews ONE chunk of segments. Critical contract: the LLM never
// sees timestamps — only Idx + Text — and must return the same set of Idx
// values. Timestamps are reattached by the use case from the original Raw.
type Reviewer interface {
	Name() string
	ReviewChunk(ctx context.Context, req ChunkRequest) (ChunkResponse, error)
}

type ChunkSegment struct {
	Idx  int    `json:"idx"`
	Text string `json:"text"`
	// Confidence is the avg word-level confidence carried over from the
	// ASR raw output [0,1]. Optional: only the hybrid reviewer reads it
	// (per-segment routing decision); single-tier reviewers ignore it.
	Confidence float64 `json:"confidence,omitempty"`
}

type ChunkRequest struct {
	Language   string         `json:"language"`
	Segments   []ChunkSegment `json:"segments"`   // segments to review (idx + text only)
	PrevTail   []ChunkSegment `json:"prev_tail"`  // read-only context from previous chunk
	SystemHint string         `json:"system_hint"`
	// ExtraPrompt is exact additional text the use case wants prepended
	// to the standard user prompt (currently the GLOSSARY HINTS block
	// emitted from glossary.RenderExtraPrompt). Reviewers that don't
	// know about it may still copy it verbatim; persisting it on the
	// chunk artifact makes the LLM input fully reproducible offline.
	ExtraPrompt string `json:"extra_prompt,omitempty"`
}

// ModelEntry records ONE model pass over a chunk. For single-pass reviewers
// the chunk has one entry; for hybrid (cheap+premium) — two. The artifact
// layer persists this list verbatim so consumers can see exactly which
// model produced which segment of the final response without re-running.
type ModelEntry struct {
	// Role describes what the call was meant to do in the chunk-level
	// pipeline: "single" (lone reviewer), "baseline" (cheap pass on a
	// hybrid chunk), or "premium" (per-island reviewer in a hybrid).
	Role string `json:"role"`
	// Outcome describes what happened to this call's output. Empty
	// (assume "accepted") or one of the OutcomeXxx constants below.
	Outcome string `json:"outcome,omitempty"`
	// Note is an optional human-readable hint that complements Outcome
	// (e.g. specific error message for transport-error). Always safe to
	// ignore — never load-bearing for the audit flow.
	Note            string    `json:"note,omitempty"`
	Name            string    `json:"name"`     // alias from YAML, e.g. "gemini-3-flash-preview"
	ModelID         string    `json:"model_id"` // upstream id, e.g. "google/gemini-3-flash-preview"
	Endpoint        string    `json:"endpoint,omitempty"`
	TokensIn        int64     `json:"tokens_in,omitempty"`
	TokensOut       int64     `json:"tokens_out,omitempty"`
	ReasoningTokens int64     `json:"reasoning_tokens,omitempty"`
	CostUSD         float64   `json:"cost_usd,omitempty"`
	Attempts        int       `json:"attempts,omitempty"`
	StartedAt       time.Time `json:"started_at,omitempty"`
	FinishedAt      time.Time `json:"finished_at,omitempty"`
	// AuditFlags is set only for entries whose response failed an audit
	// gate (carries the specific flag identifiers — empty_segments,
	// drastic_shrink, etc.). Empty for accepted entries.
	AuditFlags []string `json:"audit_flags,omitempty"`
}

// Outcome constants describe what happened to a model call. Stable
// strings so they're greppable in artifacts and can be aggregated by
// audit tooling.
const (
	OutcomeAccepted          = ""                       // call's output is in the final merged response
	OutcomeRetryIdxMismatch  = "retry-idx-mismatch"     // call's idx-set didn't match request; tryReview retried
	OutcomeRetryAuditFailed  = "retry-audit-failed"     // call passed idx-set but failed audit; tryReview retried
	OutcomeIslandRejected    = "island-rejected"        // hybrid premium: idx-set OK but audit failed on island, discarded
	OutcomeIslandTransport   = "island-transport-error" // hybrid premium: HTTP/transport failure on island
	OutcomeIslandSkipped     = "island-skipped"         // hybrid: filtered out by premium_min_chars (no API call made)
	OutcomeAttemptSuperseded = "attempt-superseded"     // whole chunk-level attempt discarded; next attempt in chain ran
)

type ChunkResponse struct {
	Segments  []ChunkSegment `json:"segments"`
	Sentences [][]int        `json:"sentences,omitempty"` // groupings of raw idx into sentences
	Models    []ModelEntry   `json:"models,omitempty"`    // one entry per model pass that contributed
	// AuditFlags carries semantic-level warnings detected after the
	// idx-set check passed but the content looks suspicious. Empty for a
	// clean response. Set in the review usecase, never by the reviewer
	// itself (so flags are uniform across providers).
	AuditFlags []string `json:"audit_flags,omitempty"`
}

// Audit-flag identifiers used in AuditFlags. Stable strings so they
// can be greppable in artifacts and aggregated by name in audit tools.
const (
	AuditEmptySegments = "empty_segments" // response has empty text where request was non-empty (model dropped content)
	AuditDrasticShrink = "drastic_shrink" // ≥1 segment shrunk to <20% of its raw length
	AuditDrasticGrowth = "drastic_growth" // ≥1 segment grew >5× raw length (model likely hallucinated extra text)
	AuditAllShifted    = "all_shifted"    // strong signal that content-to-idx mapping shifted (e.g. trailing empties + leading dense text)
)

// CriticalAuditFlag reports whether a flag should block acceptance of a
// chunk response. drastic_shrink/growth alone often reflect legitimate
// cleanup (LLM removed "uh", merged short fragments) so we don't reject
// on those — only on shifts/empties that indicate idx-text misalignment.
func CriticalAuditFlag(flag string) bool {
	switch flag {
	case AuditEmptySegments, AuditAllShifted:
		return true
	}
	return false
}

// AnyCriticalAuditFlag is a convenience predicate for slices of flags.
func AnyCriticalAuditFlag(flags []string) bool {
	for _, f := range flags {
		if CriticalAuditFlag(f) {
			return true
		}
	}
	return false
}

// DetectAuditFlags compares the response against the request and emits
// stable identifiers for content-level anomalies that the idx-set check
// can't catch:
//   - empty_segments: response has empty text where the request was non-empty
//   - drastic_shrink: at least one segment shrunk to <20% of its raw length
//   - drastic_growth: at least one segment grew >5× the raw length
//   - all_shifted: a strong shift signature (≥3 trailing empties paired with
//     non-trivial leading content), suggesting content-to-idx misalignment
//
// Lives in the port so both application (per-chunk gate) and infra
// (hybrid per-island gate) apply identical heuristics.
func DetectAuditFlags(req ChunkRequest, resp ChunkResponse) []string {
	if len(req.Segments) == 0 || len(resp.Segments) == 0 {
		return nil
	}
	rawByIdx := make(map[int]string, len(req.Segments))
	for _, s := range req.Segments {
		rawByIdx[s.Idx] = s.Text
	}

	flags := map[string]struct{}{}
	emptyResp := 0
	for _, s := range resp.Segments {
		raw, ok := rawByIdx[s.Idx]
		if !ok {
			continue
		}
		respText := strings.TrimSpace(s.Text)
		rawText := strings.TrimSpace(raw)

		if respText == "" && rawText != "" {
			flags[AuditEmptySegments] = struct{}{}
			emptyResp++
			continue
		}
		if rawText == "" {
			continue
		}
		ratio := float64(len(respText)) / float64(len(rawText))
		if ratio < 0.2 {
			flags[AuditDrasticShrink] = struct{}{}
		} else if ratio > 5 {
			flags[AuditDrasticGrowth] = struct{}{}
		}
	}

	if emptyResp >= 3 && auditTailIsEmpty(resp.Segments, emptyResp/2+1) {
		flags[AuditAllShifted] = struct{}{}
	}

	if len(flags) == 0 {
		return nil
	}
	out := make([]string, 0, len(flags))
	for f := range flags {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

func auditTailIsEmpty(segs []ChunkSegment, n int) bool {
	if n <= 0 || n > len(segs) {
		return false
	}
	for i := len(segs) - n; i < len(segs); i++ {
		if strings.TrimSpace(segs[i].Text) != "" {
			return false
		}
	}
	return true
}

// HybridOverrides lets a chain attempt customise hybrid policy knobs
// per-attempt without touching the global review.hybrid defaults. Nil
// fields mean "inherit from registry's default settings". When passed
// to Compose with len(models) != 2 the overrides are ignored.
type HybridOverrides struct {
	Threshold       *float64
	Expand          *int
	PremiumMinChars *int
}

// Registry holds the available providers and resolves a list of model
// aliases to a single Reviewer. Application layer never knows about
// concrete strategies (single-pass, hybrid baseline+premium) — it just
// asks the registry to compose what the caller requested.
type Registry interface {
	Register(r Reviewer)
	Get(name string) (Reviewer, bool)
	List() []string
	// Compose resolves a model-alias list to one Reviewer:
	//   - len 1 → the registered reviewer for that name
	//   - len 2 → a hybrid wrapper (baseline + premium on low-conf islands)
	// Higher arities are rejected. overrides may be nil for default
	// hybrid behaviour; non-nil fields override per-attempt.
	Compose(models []string, overrides *HybridOverrides) (Reviewer, error)
}

// Helper for converting raw segments into ChunkSegments.
func ChunkSegmentsFromRaw(raw []transcript.RawSegment) []ChunkSegment {
	out := make([]ChunkSegment, len(raw))
	for i, s := range raw {
		out[i] = ChunkSegment{Idx: s.Idx, Text: s.Text, Confidence: s.Confidence}
	}
	return out
}
