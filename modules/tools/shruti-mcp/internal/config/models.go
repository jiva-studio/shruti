package config

// ProviderOptions describes one OpenAI-compatible review provider entry.
// All review providers go through the same /v1/chat/completions adapter —
// only the upstream URL, key, and model id differ. Used as-is for resolver
// providers too (Anthropic resolver/translator paths).
type ProviderOptions struct {
	// Endpoint is the OpenAI-compatible base URL, e.g.
	// https://openrouter.ai/api/v1 or http://localhost:11434/v1 (Ollama).
	// Resolver/metadata providers ignore this — they use the shared
	// Anthropic client.
	Endpoint string `yaml:"endpoint,omitempty"`
	APIKey   string `yaml:"api_key,omitempty"`
	// Model is the upstream id (OpenRouter format includes namespace,
	// e.g. "google/gemini-3-flash-preview"). For Anthropic-direct adapters
	// it's the Claude model name, e.g. "claude-haiku-4-5".
	Model      string `yaml:"model"`
	MaxTokens  int    `yaml:"max_tokens"`
	PromptPath string `yaml:"prompt_path,omitempty"`
	// Reasoning toggles per-provider thinking. "off" sends
	// reasoning.max_tokens=0; "on" lets the upstream decide; empty defaults
	// to the model's own default behaviour. Ignored by upstreams that
	// don't expose a reasoning toggle.
	Reasoning string `yaml:"reasoning,omitempty"`
	// Format is the review reply shape: "json" (default) returns every
	// segment, "lines" returns only the corrected ones plus sentence-end
	// boundaries. Output is billed well above input, and most of the JSON
	// reply was unchanged text, so "lines" measured ~45% cheaper at equal
	// accuracy. Per-provider because it depends on the model holding the
	// looser contract.
	Format string `yaml:"format,omitempty"`
}

type Resolver struct {
	Default        string                     `yaml:"default"`
	CandidatesTopN int                        `yaml:"candidates_top_n"`
	Providers      map[string]ProviderOptions `yaml:"providers"`
}

func (r *Resolver) applyDefaults() {
	if r.CandidatesTopN == 0 {
		r.CandidatesTopN = 30
	}
	if r.Providers == nil {
		r.Providers = map[string]ProviderOptions{}
	}
	for name, p := range r.Providers {
		if p.MaxTokens == 0 {
			p.MaxTokens = 1024
		}
		r.Providers[name] = p
	}
}

type Metadata struct {
	Endpoint   string `yaml:"endpoint"`
	APIKey     string `yaml:"api_key"`
	Model      string `yaml:"model"`
	MaxTokens  int    `yaml:"max_tokens"`
	PromptPath string `yaml:"prompt_path"`
}

func (m *Metadata) applyDefaults() {
	if m.MaxTokens == 0 {
		m.MaxTokens = 1024
	}
}

// Outline configures lecture outline + description generation via an
// OpenAI-compatible model (Gemini through OpenRouter). When APIKey is empty the
// feature is disabled (track.transcript.outline / pipeline.run op=outline
// return a clear error).
type Outline struct {
	Endpoint  string `yaml:"endpoint"`
	APIKey    string `yaml:"api_key"`
	Model     string `yaml:"model"`
	MaxTokens int    `yaml:"max_tokens"`
	Reasoning string `yaml:"reasoning,omitempty"`
	// Compress shortens each transcript block before it is sent: "" / "none"
	// leaves it as written, "punctuation" drops the marks this task does not
	// read (12% of the input, no change to the headings produced). The
	// time-code is attached after compression, so it is never an input to it.
	Compress string `yaml:"compress,omitempty"`
	// Batch, when set, is the half-price asynchronous path: the same model
	// through the provider's batch endpoint, results within 24 hours.
	Batch OutlineBatch `yaml:"batch,omitempty"`
}

// OutlineBatch points at the Gemini batch endpoint directly rather than through
// an OpenAI-compatible proxy — the batch protocol is not part of that surface,
// and this is the client the review path already uses.
type OutlineBatch struct {
	Endpoint string `yaml:"endpoint,omitempty"`
	APIKey   string `yaml:"api_key,omitempty"`
	Model    string `yaml:"model,omitempty"`
}

// Embed configures the text-embeddings endpoint used by the topic build/assign
// (clustering outline headings into canonical topics). OpenAI-compatible
// (text-embedding-3-small via OpenRouter/OpenAI). When APIKey is empty the
// topic tools are disabled (topics.build / track.topics.assign return a clear
// error). Dimensions trims the vector (256 is plenty for clustering); batch
// caps inputs per HTTP call.
type Embed struct {
	Endpoint   string `yaml:"endpoint,omitempty"`
	APIKey     string `yaml:"api_key"`
	Model      string `yaml:"model"`
	Dimensions int    `yaml:"dimensions,omitempty"`
	BatchSize  int    `yaml:"batch_size,omitempty"`
}

// Images configures collection-cover generation via an OpenRouter-compatible
// image model. When APIKey is empty the feature is disabled (collection.create
// won't auto-generate and collection.cover.generate returns a clear error).
type Images struct {
	Endpoint string `yaml:"endpoint,omitempty"`
	APIKey   string `yaml:"api_key,omitempty"`
	Model    string `yaml:"model,omitempty"`
	// Style is appended to every prompt so all covers share one look.
	Style string `yaml:"style,omitempty"`
}

func (i *Images) applyDefaults() {
	if i.Endpoint == "" {
		i.Endpoint = "https://openrouter.ai/api/v1"
	}
	if i.Model == "" {
		i.Model = "google/gemini-2.5-flash-image"
	}
	if i.Style == "" {
		i.Style = defaultImageStyle
	}
}

const defaultImageStyle = "Devotional illustration in the Gaudiya Vaishnava (Hare Krishna / ISKCON) tradition. Warm palette of saffron, cream and soft gold; gentle painterly digital art; serene and uplifting; soft golden-hour light. Full-bleed square 1:1 composition that COMPLETELY fills the frame edge to edge — absolutely no white border, no frame, no margin, no rounded corners, no vignette, no passe-partout. Absolutely no text, words or letters. Every Vaishnava person wears authentic Gaudiya Vaishnava tilaka: two thin vertical pale clay-yellow (gopi-chandana) lines painted on the forehead that come together at the bridge of the nose forming a narrow U/V shape, with a small tulasi-leaf mark at the base on the nose — never horizontal Shaivite lines, never a single dot. Devotees wear dhoti or sari. Avoid Buddhist and generic new-age imagery — no Buddha, no buddhist temples."
