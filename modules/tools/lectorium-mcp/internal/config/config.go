package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	In              string `yaml:"in"`
	Out             string `yaml:"out"`
	DB              string `yaml:"db"`
	RunsDB          string `yaml:"runs_db"`
	DefaultLanguage string `yaml:"default_language"`

	// Concurrency caps how many files may sit inside a stage at once, by stage
	// name (ingested, normalized, metadata, transcribed, reviewed, committed).
	// The worker pool is file-level, so without this one number has to serve
	// stages with opposite needs: transcribe waits on a remote box and wants
	// many workers in parallel, while normalize and commit contend for the
	// local disk, where concurrent access on a mechanical drive costs most of
	// the throughput. Absent or 0 = unrestricted.
	Concurrency map[string]int `yaml:"concurrency,omitempty"`

	CDN        CDN        `yaml:"cdn"`
	S3         S3         `yaml:"s3"`
	FFmpeg     FFmpeg     `yaml:"ffmpeg"`
	Denoiser   Denoiser   `yaml:"denoiser"`
	Transcribe Transcribe `yaml:"transcribe"`
	Review     Review     `yaml:"review"`
	Resolver   Resolver   `yaml:"resolver"`
	Metadata   Metadata   `yaml:"metadata"`
	Outline    Outline    `yaml:"outline"`
	Embed      Embed      `yaml:"embed"`
	Images     Images     `yaml:"images"`
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

type CDN struct {
	ReadBaseURL string `yaml:"read_base_url"`
}

type S3 struct {
	AWS    S3Target    `yaml:"aws"`
	Yandex S3Target    `yaml:"yandex"`
	Bunny  BunnyTarget `yaml:"bunny"`
}

type S3Target struct {
	Bucket          string `yaml:"bucket"`
	Region          string `yaml:"region"`
	Endpoint        string `yaml:"endpoint"`
	AccessKeyID     string `yaml:"access_key_id"`
	SecretAccessKey string `yaml:"secret_access_key"`
	ForcePathStyle  bool   `yaml:"force_path_style"`
}

// BunnyTarget configures a Bunny.net Edge Storage publish target. Bunny is not
// S3-compatible, so it has its own shape: Zone is the storage-zone name,
// AccessKey is the storage-zone password (read+write), Endpoint defaults to the
// main storage host. Enabled when Zone is non-empty.
type BunnyTarget struct {
	Zone      string `yaml:"zone"`
	Endpoint  string `yaml:"endpoint"`
	AccessKey string `yaml:"access_key"`
}

type FFmpeg struct {
	Bin string `yaml:"bin"`
}

// Denoiser configures the audio-denoiser subprocess used by track.audio.denoise.
type Denoiser struct {
	PythonBin string `yaml:"python_bin"` // interpreter with the denoise deps; default "python3"
	Script    string `yaml:"script"`     // path to audio-denoiser/denoise_mp3.py
}

// Transcribe configures the transcription stage. Multiple providers can be
// listed; the one named in `default` is used when transcript_create is
// invoked without an explicit `provider` argument.
type Transcribe struct {
	Default   string                        `yaml:"default"`
	Providers map[string]TranscribeProvider `yaml:"providers"`
}

// TranscribeProvider is a discriminated union — `kind` selects which
// adapter to instantiate; the other fields are kind-specific.
type TranscribeProvider struct {
	Kind     string `yaml:"kind"`               // "transcriber-service" | "deepgram"
	Model    string `yaml:"model,omitempty"`    // optional model override
	APIKey   string `yaml:"api_key,omitempty"`  // deepgram (env-substituted)
	Endpoint string `yaml:"endpoint,omitempty"` // transcriber-service
	Language string `yaml:"language,omitempty"` // deepgram; empty = multi
	Diarize  *bool  `yaml:"diarize,omitempty"`  // deepgram; unset follows multi
}

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
//	# legacy list of aliases (no overrides)
//	- [gemini-3.1-flash-lite, gemini-3-flash-preview]
//
//	# struct form with per-attempt overrides
//	- models: [gemini-3.1-flash-lite, gemini-3-flash-preview]
//	  premium_min_chars: 20
//	  threshold: 0.70
//
// The legacy form keeps existing configs working unchanged.
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

type Resolver struct {
	Default        string                     `yaml:"default"`
	CandidatesTopN int                        `yaml:"candidates_top_n"`
	Providers      map[string]ProviderOptions `yaml:"providers"`
}

type Metadata struct {
	Endpoint   string `yaml:"endpoint"`
	APIKey     string `yaml:"api_key"`
	Model      string `yaml:"model"`
	MaxTokens  int    `yaml:"max_tokens"`
	PromptPath string `yaml:"prompt_path"`
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

// Load reads YAML config from path, expands ${ENV_VAR} and ~, applies defaults.
//
// Before parsing, Load looks for a `.env` file alongside the YAML and in the
// current working directory and loads any `KEY=VALUE` lines into the process
// env. Existing process env wins (so secrets in env override file values).
// This keeps S3 credentials project-local — no home-dir lookups.
func Load(path string) (*Config, error) {
	loadDotEnvNear(path)

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	expanded := expandEnv(string(raw))

	var c Config
	if err := yaml.Unmarshal([]byte(expanded), &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	c.In = expandTilde(c.In)
	c.Out = expandTilde(c.Out)
	c.DB = expandTilde(c.DB)
	c.RunsDB = expandTilde(c.RunsDB)
	for name, p := range c.Transcribe.Providers {
		p.Model = expandTilde(p.Model)
		c.Transcribe.Providers[name] = p
	}

	c.applyDefaults()

	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	if c.DefaultLanguage == "" {
		c.DefaultLanguage = "ru"
	}
	if c.DB == "" && c.Out != "" {
		c.DB = filepath.Join(c.Out, "artifacts", "lake", "index.db")
	}
	if c.RunsDB == "" && c.Out != "" {
		c.RunsDB = filepath.Join(c.Out, "artifacts", "lake", "runs.db")
	}
	if c.CDN.ReadBaseURL == "" {
		c.CDN.ReadBaseURL = "https://akds-lectorium.b-cdn.net"
	}
	// AWS is opt-in: catalog publish targets Bunny Edge Storage. Only default
	// the region when a bucket is explicitly configured — an empty aws block
	// means "no S3 publish target" (main.go skips it when Bucket == "").
	if c.S3.AWS.Bucket != "" && c.S3.AWS.Region == "" {
		c.S3.AWS.Region = "us-east-1"
	}
	if c.S3.Yandex.Region == "" {
		c.S3.Yandex.Region = "ru-central1"
	}
	if c.S3.Yandex.Endpoint == "" {
		c.S3.Yandex.Endpoint = "https://storage.yandexcloud.net"
	}
	if c.S3.Bunny.Zone != "" && c.S3.Bunny.Endpoint == "" {
		c.S3.Bunny.Endpoint = "https://storage.bunnycdn.com"
	}
	if c.Images.Endpoint == "" {
		c.Images.Endpoint = "https://openrouter.ai/api/v1"
	}
	if c.Images.Model == "" {
		c.Images.Model = "google/gemini-2.5-flash-image"
	}
	if c.Images.Style == "" {
		c.Images.Style = "Devotional illustration in the Gaudiya Vaishnava (Hare Krishna / ISKCON) tradition. Warm palette of saffron, cream and soft gold; gentle painterly digital art; serene and uplifting; soft golden-hour light. Full-bleed square 1:1 composition that COMPLETELY fills the frame edge to edge — absolutely no white border, no frame, no margin, no rounded corners, no vignette, no passe-partout. Absolutely no text, words or letters. Every Vaishnava person wears authentic Gaudiya Vaishnava tilaka: two thin vertical pale clay-yellow (gopi-chandana) lines painted on the forehead that come together at the bridge of the nose forming a narrow U/V shape, with a small tulasi-leaf mark at the base on the nose — never horizontal Shaivite lines, never a single dot. Devotees wear dhoti or sari. Avoid Buddhist and generic new-age imagery — no Buddha, no buddhist temples."
	}
	if c.FFmpeg.Bin == "" {
		c.FFmpeg.Bin = "ffmpeg"
	}
	if c.Denoiser.PythonBin == "" {
		c.Denoiser.PythonBin = "python3"
	}
	if c.Transcribe.Default == "" {
		c.Transcribe.Default = "transcriber-service"
	}
	if c.Transcribe.Providers == nil {
		c.Transcribe.Providers = map[string]TranscribeProvider{}
	}
	if c.Review.ChunkSize == 0 {
		c.Review.ChunkSize = 50
	}
	if c.Review.Overlap == 0 {
		c.Review.Overlap = 4
	}
	// Retries defaults to 0 (no retry on idx-mismatch / audit-fail) —
	// those errors are deterministic on the same model+input, retrying
	// just spends money. Transient HTTP errors (429, 5xx) are retried
	// inside openaicompat.Client.Run regardless of this setting.
	// YAML can opt back into application-level retries with retries: 1+.
	if c.Review.Concurrency == 0 {
		c.Review.Concurrency = 3
	}
	if c.Review.MaxConcurrentLLM == 0 {
		c.Review.MaxConcurrentLLM = 6
	}
	if c.Review.Hybrid.Threshold == 0 {
		c.Review.Hybrid.Threshold = 0.70
	}
	if c.Review.Hybrid.Expand == 0 {
		c.Review.Hybrid.Expand = 2
	}
	if c.Review.Providers == nil {
		c.Review.Providers = map[string]ProviderOptions{}
	}
	if c.Review.Default == nil {
		c.Review.Default = map[string][]Attempt{}
	}
	for name, p := range c.Review.Providers {
		if p.MaxTokens == 0 {
			p.MaxTokens = 4096
		}
		c.Review.Providers[name] = p
	}
	if c.Resolver.CandidatesTopN == 0 {
		c.Resolver.CandidatesTopN = 30
	}
	if c.Resolver.Providers == nil {
		c.Resolver.Providers = map[string]ProviderOptions{}
	}
	for name, p := range c.Resolver.Providers {
		if p.MaxTokens == 0 {
			p.MaxTokens = 1024
		}
		c.Resolver.Providers[name] = p
	}
	if c.Metadata.MaxTokens == 0 {
		c.Metadata.MaxTokens = 1024
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

func (c *Config) validate() error {
	if c.In == "" {
		return fmt.Errorf("config: 'in' is required")
	}
	if c.Out == "" {
		return fmt.Errorf("config: 'out' is required")
	}
	return nil
}

var envPattern = regexp.MustCompile(`\$\{([A-Z_][A-Z0-9_]*)\}`)

func expandEnv(s string) string {
	return envPattern.ReplaceAllStringFunc(s, func(match string) string {
		name := match[2 : len(match)-1]
		return os.Getenv(name)
	})
}

func expandTilde(p string) string {
	if p == "" || !strings.HasPrefix(p, "~") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}
