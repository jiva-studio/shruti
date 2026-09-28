package config

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

type Review struct {
	// Default holds a per-language CHAIN of attempts. Each attempt is
	// either a list of model aliases ([lite, flash-preview]) or a
	// struct that adds per-attempt overrides for the hybrid knobs
	// (threshold/expand/premium_min_chars). The use case tries attempts
	// in order; audit failure on attempt N falls through to attempt
	// N+1, and a final-attempt failure leaves the chunk in degraded
	// mode (raw). Lookup falls back to "*" when a language isn't
	// explicitly listed.
	Default     map[string][]Attempt `yaml:"default"`
	ChunkSize   int                  `yaml:"chunk_size"`
	Overlap     int                  `yaml:"overlap"`
	Retries     int                  `yaml:"retries"`
	Concurrency int                  `yaml:"concurrency"`
	// MaxConcurrentLLM caps total in-flight LLM calls across the worker
	// pool. Without this, workers × Concurrency can fan out beyond the
	// API tier's RPM budget.
	MaxConcurrentLLM int `yaml:"max_concurrent_llm"`
	// NoiseFilterThreshold drops the text of raw segments whose Whisper
	// confidence is below this cutoff before they reach the LLM (0 =
	// disabled). 0.20 catches whisper hallucinations on noise/silence
	// (digits, isolated dots, quote-soup) without risking real speech.
	NoiseFilterThreshold float64                    `yaml:"noise_filter_threshold"`
	Hybrid               HybridOptions              `yaml:"hybrid"`
	Providers            map[string]ProviderOptions `yaml:"providers"`
	// Sentencer optionally configures a deterministic sentence splitter
	// (razdel subprocess). When script is set, the review usecase uses
	// it to compute sentence boundaries from the corrected text instead
	// of trusting the LLM's own grouping verdicts. Empty disables the
	// splitter; the use case keeps its boundary-voting fallback.
	Sentencer SentencerOptions `yaml:"sentencer"`
	// Glossary optionally activates Vaishnava-terminology RAG-style
	// hint injection per chunk and a canonical-form safety net on
	// reviewed text. Empty Path disables the feature.
	Glossary GlossaryOptions `yaml:"glossary"`
	// Batch optionally enables the half-price job path: chunks go to a
	// provider batch endpoint that finishes within 24 hours instead of a
	// live call. Empty APIKey disables it.
	Batch ReviewBatchOptions `yaml:"batch"`
	// AlignPDF optionally activates the PDF-canon early-branch: when a
	// transcript.pdf is present alongside the raw ASR for a track, we
	// skip the LLM entirely and align the canonical PDF text to the raw
	// timestamps. Empty ScriptPath disables the feature; the use case
	// then always falls through to the LLM.
	AlignPDF AlignPDFOptions `yaml:"align_pdf"`
}

// GlossaryOptions configures the Vaishnava-terminology RAG layer.
// All fields fall back to sensible defaults when omitted; the YAML
// itself is auto-discovered next to the binary.
type GlossaryOptions struct {
	Path             string  `yaml:"path"`                // override path to glossary.yaml; empty = look next to the binary
	MatchThreshold   float64 `yaml:"match_threshold"`     // trigram similarity cutoff (default 0.55)
	MaxHintsPerChunk int     `yaml:"max_hints_per_chunk"` // cap injected hints (default 10)
}

// ReviewBatchOptions configures the batch review path. Only Gemini exposes a
// batch endpoint for the models we use, so there is no provider switch.
type ReviewBatchOptions struct {
	Endpoint  string `yaml:"endpoint,omitempty"`
	APIKey    string `yaml:"api_key,omitempty"`
	Model     string `yaml:"model,omitempty"`
	MaxTokens int    `yaml:"max_tokens,omitempty"`
	// The batch endpoint reports no price — usageMetadata carries tokens and
	// nothing else — so the per-million rates come from config. Set them to
	// the discounted batch rates, not the live ones. Left at 0 the chunk
	// artifacts carry tokens without a cost rather than a made-up one.
	InputPerMillion  float64 `yaml:"input_per_million,omitempty"`
	OutputPerMillion float64 `yaml:"output_per_million,omitempty"`
}

// SentencerOptions points at the razdel subprocess script.
type SentencerOptions struct {
	PythonBin  string `yaml:"python_bin"`  // default "python3"
	ScriptPath string `yaml:"script_path"` // path to scripts/sentencesplit/sentencer.py
}

// AlignPDFOptions points at the scripts/pdf_align/daemon.py subprocess.
// Same shape as SentencerOptions — both are long-lived Python sidecars
// driven by JSON-line stdin/stdout.
type AlignPDFOptions struct {
	PythonBin  string `yaml:"python_bin"`  // default "python3"
	ScriptPath string `yaml:"script_path"` // path to scripts/pdf_align/daemon.py
}

// HybridOptions controls the runtime hybrid wrapper that activates when
// `models` has 2 elements (cheap baseline + premium fixup on low-conf islands).
type HybridOptions struct {
	Threshold float64 `yaml:"threshold"` // confidence cutoff (default 0.70)
	Expand    int     `yaml:"expand"`    // segments of context around each island (default 2)
	// PremiumMinChars skips the premium pass for an island when the
	// summed character length of its low-confidence segments is below
	// this threshold. Useful to avoid paying $0.02-0.03 to "fix" a
	// single short whisper artefact like "..." or "Да." — the cheap
	// baseline already handles those. Default 0 disables the filter.
	PremiumMinChars int `yaml:"premium_min_chars"`
}

// Attempt describes one entry in the chain at review.default[lang].
// Models is required; the *override fields are nil unless the attempt
// explicitly overrides the top-level review.hybrid defaults.
type Attempt struct {
	Models          []string `yaml:"models"`
	Threshold       *float64 `yaml:"threshold,omitempty"`
	Expand          *int     `yaml:"expand,omitempty"`
	PremiumMinChars *int     `yaml:"premium_min_chars,omitempty"`
}

// UnmarshalYAML accepts either of two shapes:
//
//	# list of aliases (no overrides)
//	- [gemini-3.1-flash-lite, gemini-3-flash-preview]
//
//	# struct form with per-attempt overrides
//	- models: [gemini-3.1-flash-lite, gemini-3-flash-preview]
//	  premium_min_chars: 20
//	  threshold: 0.70
func (a *Attempt) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.SequenceNode {
		var models []string
		if err := value.Decode(&models); err != nil {
			return fmt.Errorf("review.default attempt (list form): %w", err)
		}
		a.Models = models
		return nil
	}
	type rawAttempt struct {
		Models          []string `yaml:"models"`
		Threshold       *float64 `yaml:"threshold,omitempty"`
		Expand          *int     `yaml:"expand,omitempty"`
		PremiumMinChars *int     `yaml:"premium_min_chars,omitempty"`
	}
	var ra rawAttempt
	if err := value.Decode(&ra); err != nil {
		return fmt.Errorf("review.default attempt (struct form): %w", err)
	}
	a.Models = ra.Models
	a.Threshold = ra.Threshold
	a.Expand = ra.Expand
	a.PremiumMinChars = ra.PremiumMinChars
	return nil
}

func (r *Review) applyDefaults() {
	if r.ChunkSize == 0 {
		r.ChunkSize = 50
	}
	if r.Overlap == 0 {
		r.Overlap = 4
	}
	// Retries stays 0 unless set: an index mismatch or a failed audit is
	// deterministic for the same model and input, so a retry only spends
	// money. Transient HTTP errors (429, 5xx) are retried inside the client
	// regardless.
	if r.Concurrency == 0 {
		r.Concurrency = 3
	}
	if r.MaxConcurrentLLM == 0 {
		r.MaxConcurrentLLM = 6
	}
	if r.Hybrid.Threshold == 0 {
		r.Hybrid.Threshold = 0.70
	}
	if r.Hybrid.Expand == 0 {
		r.Hybrid.Expand = 2
	}
	if r.Providers == nil {
		r.Providers = map[string]ProviderOptions{}
	}
	if r.Default == nil {
		r.Default = map[string][]Attempt{}
	}
	for name, p := range r.Providers {
		if p.MaxTokens == 0 {
			p.MaxTokens = 4096
		}
		r.Providers[name] = p
	}
}

// DefaultReviewAttempts returns the configured attempt chain for a
// language. Falls back to the "*" entry when no per-language override
// exists. Empty result means the caller must specify models explicitly.
func (r Review) DefaultReviewAttempts(language string) []Attempt {
	src, ok := r.Default[language]
	if !ok || len(src) == 0 {
		src, ok = r.Default["*"]
		if !ok {
			return nil
		}
	}
	out := make([]Attempt, len(src))
	for i, a := range src {
		out[i] = Attempt{
			Models:          append([]string{}, a.Models...),
			Threshold:       a.Threshold,
			Expand:          a.Expand,
			PremiumMinChars: a.PremiumMinChars,
		}
	}
	return out
}
