// Package title re-derives a clean human-readable track title via a
// small LLM call, replacing whatever the metadata-extract stage put in
// place from the filename alone.
//
// The orchestrator collects four kinds of context for the LLM:
//   - structured metadata (kind tag, references, location, date) from the
//     metadata stage payload
//   - first ~500 words of substantive transcript (kīrtana / opening
//     verses skipped) from public reviewed transcript, falling back to
//     raw ASR when the public file isn't on disk yet
//   - the PDF first-page header as a soft hint (when a PDF exists)
//
// Then it calls SetTrackMetadata so the new title flows into both the
// metadata stage payload AND, if the track is already committed, the
// catalog row directly. Cascade-reset of committed/* keeps next
// track_commit re-validating against the patched payload.
package title

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/alignpdf"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/commit"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
	alignpdfport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/alignpdf"
	lakeport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
	titleport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/title"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
)

const (
	excerptWordTarget      = 500
	excerptWordTargetRetry = 2000
	maxTitleLen            = 120
)

// refusalPrefixes are sentence-starters that signal the LLM declined to
// title the excerpt instead of returning a real title. Matched lower-case
// against TrimSpace(output).
var refusalPrefixes = []string{
	"i cannot", "i can't", "i need", "i appreciate",
	"the transcript", "without ", "unfortunately",
}

func isRefusalOutput(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > maxTitleLen {
		return true
	}
	lower := strings.ToLower(s)
	for _, p := range refusalPrefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

type UseCase struct {
	Registry         lakeport.Registry
	Transcripts      transcriptport.Store
	Aligner          alignpdfport.Aligner // optional; nil when pdf_align is not configured
	LLM              titleport.Extractor
	SetTrackMetadata commit.SetTrackMetadataUseCase
	OutDir           string
}

type Result struct {
	TrackId    track.Id `json:"track_id"`
	Language   string   `json:"language"`
	OldTitle   string   `json:"old_title"`
	NewTitle   string   `json:"new_title"`
	HeaderHint string   `json:"header_hint,omitempty"`
	Source     string   `json:"transcript_source"` // "public" | "raw"
}

// metadataPayload is the subset of extractmeta.Result we need. Decoding
// against a partial struct keeps us decoupled from extractmeta's full
// schema (which has audit fields we don't care about).
type metadataPayload struct {
	Title        string `json:"title"`
	Date         string `json:"date,omitempty"`
	LocationName string `json:"location_name,omitempty"`
	LocationRaw  string `json:"location_raw,omitempty"`
	KindTag      string `json:"kind_tag,omitempty"`
	References   []struct {
		SourceShortName string `json:"source_short_name,omitempty"`
		SourceCode      string `json:"source_code,omitempty"`
		Tokens          string `json:"tokens"`
	} `json:"references"`
}

// supportedLanguages is the closed allowlist of ISO-639 codes the
// pipeline understands. Anything outside is rejected up-front rather
// than letting an unknown locale propagate into the catalog as an
// orphan track_variants row. Keep in sync with the values used in
// transcript.create / review / commit (ru / en / hi).
var supportedLanguages = map[string]bool{"ru": true, "en": true, "hi": true}

// SupportedLanguage reports whether the given ISO-639 code is part of
// the configured pipeline locale set. Exported for tests + future
// reuse from other use cases that accept a language parameter.
func SupportedLanguage(code string) bool { return supportedLanguages[code] }

func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (Result, error) {
	if uc.LLM == nil {
		return Result{}, fmt.Errorf("titles: LLM extractor not configured")
	}
	if !SupportedLanguage(language) {
		return Result{}, fmt.Errorf("titles: unsupported language %q (allowed: en, ru, hi)", language)
	}

	// 1. metadata payload
	metaKey := pipeline.Key{Stage: pipeline.StageMetadataExtracted}
	stage, ok, err := uc.Registry.GetStage(ctx, id, metaKey)
	if err != nil {
		return Result{}, fmt.Errorf("read metadata stage: %w", err)
	}
	if !ok || len(stage.Payload) == 0 {
		return Result{}, fmt.Errorf("metadata stage not done — run metadata_extract first")
	}
	var meta metadataPayload
	if err := json.Unmarshal(stage.Payload, &meta); err != nil {
		return Result{}, fmt.Errorf("parse metadata payload: %w", err)
	}

	// 2. transcript excerpt
	excerpt, source, err := uc.buildExcerpt(ctx, id, language, excerptWordTarget)
	if err != nil {
		return Result{}, err
	}
	firstExcerptWords := len(strings.Fields(excerpt))

	// 3. PDF header hint (best-effort; never fatal)
	headerHint := ""
	if uc.Aligner != nil {
		pdfPath := alignpdf.PDFPath(uc.OutDir, id)
		if _, err := os.Stat(pdfPath); err == nil {
			h, err := uc.Aligner.ExtractTitleHint(ctx, pdfPath)
			if err == nil {
				headerHint = h
			}
		}
	}

	// 4. LLM — first pass with default excerpt.
	in := titleport.Input{
		Language:   language,
		Kind:       meta.KindTag,
		References: formatReferences(meta.References),
		Location:   firstNonEmpty(meta.LocationName, meta.LocationRaw),
		Date:       meta.Date,
		HeaderHint: headerHint,
		Transcript: excerpt,
	}
	newTitle, err := uc.LLM.Extract(ctx, in)
	if err != nil {
		return Result{}, fmt.Errorf("title llm: %w", err)
	}
	newTitle = strings.TrimSpace(newTitle)

	// 4b. If the LLM refused (returned an explanation instead of a title),
	// retry once with a bigger excerpt. If retry also refuses (or no
	// more transcript is available), fail instead of storing the refusal
	// text as the title.
	if isRefusalOutput(newTitle) {
		bigger, biggerSource, berr := uc.buildExcerpt(ctx, id, language, excerptWordTargetRetry)
		if berr != nil {
			return Result{}, fmt.Errorf("title: refused on first pass, retry excerpt: %w", berr)
		}
		if len(strings.Fields(bigger)) <= firstExcerptWords {
			return Result{}, fmt.Errorf("title: transcript too thin (%d words) for LLM titling", firstExcerptWords)
		}
		in.Transcript = bigger
		source = biggerSource
		retried, rerr := uc.LLM.Extract(ctx, in)
		if rerr != nil {
			return Result{}, fmt.Errorf("title llm (retry): %w", rerr)
		}
		retried = strings.TrimSpace(retried)
		if isRefusalOutput(retried) {
			return Result{}, fmt.Errorf("title: LLM refused even with %d-word excerpt — transcript too thin to title", len(strings.Fields(bigger)))
		}
		newTitle = retried
	}

	// 5. patch metadata payload + cascade-reset commit; if committed catalog
	//    row exists, that path also updates track_variants.title in place.
	if err := uc.SetTrackMetadata.Run(ctx, commit.SetTrackMetadataInput{
		TrackId:  id,
		Language: language,
		Title:    &newTitle,
	}); err != nil {
		return Result{}, fmt.Errorf("set metadata: %w", err)
	}

	return Result{
		TrackId:    id,
		Language:   language,
		OldTitle:   meta.Title,
		NewTitle:   newTitle,
		HeaderHint: headerHint,
		Source:     source,
	}, nil
}

// buildExcerpt walks (public → raw) and returns ~500 words of substantive
// transcript. Returns an `os.ErrNotExist`-wrapping error when neither
// source is on disk so the bulk caller can surface a clean
// `no_transcript_source` row.
func (uc UseCase) buildExcerpt(ctx context.Context, id track.Id, language string, wordTarget int) (string, string, error) {
	rev, err := uc.Transcripts.ReadReviewed(ctx, id, language)
	if err == nil {
		return excerptFromReviewed(rev.Blocks, wordTarget), "public", nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", "", fmt.Errorf("read public transcript: %w", err)
	}
	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err == nil {
		return excerptFromRaw(raw.Segments, wordTarget), "raw", nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return "", "", fmt.Errorf("no_transcript_source: neither public/%s.json nor raw.json exists", language)
	}
	return "", "", fmt.Errorf("read raw transcript: %w", err)
}

// excerptFromReviewed pulls sentence text from the reviewed v2 blocks,
// dropping leading verse blocks (opening shloka recitation) and short
// sentence blocks (Hare Kṛṣṇa / Yes / Devotee:) before collecting up to
// `target` words.
func excerptFromReviewed(blocks []transcript.Block, target int) string {
	started := false
	var b strings.Builder
	words := 0
	for _, blk := range blocks {
		s, ok := blk.(transcript.SentenceBlock)
		if !ok {
			// verse:text / verse:translation / paragraph: drop while still
			// in the lead-in; once we've started collecting, stop the
			// instant we hit a non-sentence so we don't pull extra verse
			// blocks deep into the body.
			if started {
				break
			}
			continue
		}
		text := strings.TrimSpace(s.Text)
		if text == "" {
			continue
		}
		w := wordCount(text)
		if !started && w < 5 {
			continue
		}
		started = true
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(text)
		words += w
		if words >= target {
			break
		}
	}
	return b.String()
}

// excerptFromRaw does the same shape on raw ASR segments — no block
// types here, just text per segment, so the only filter is the
// short-segment lead-in skip.
func excerptFromRaw(segs []transcript.RawSegment, target int) string {
	started := false
	var b strings.Builder
	words := 0
	for _, s := range segs {
		text := strings.TrimSpace(s.Text)
		if text == "" {
			continue
		}
		w := wordCount(text)
		if !started && w < 5 {
			continue
		}
		started = true
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(text)
		words += w
		if words >= target {
			break
		}
	}
	return b.String()
}

func wordCount(s string) int {
	return len(strings.Fields(s))
}

func formatReferences(refs []struct {
	SourceShortName string `json:"source_short_name,omitempty"`
	SourceCode      string `json:"source_code,omitempty"`
	Tokens          string `json:"tokens"`
}) string {
	if len(refs) == 0 {
		return ""
	}
	parts := make([]string, 0, len(refs))
	for _, r := range refs {
		name := firstNonEmpty(r.SourceShortName, r.SourceCode)
		if name == "" {
			continue
		}
		if strings.TrimSpace(r.Tokens) == "" {
			parts = append(parts, name)
		} else {
			parts = append(parts, name+" "+strings.TrimSpace(r.Tokens))
		}
	}
	return strings.Join(parts, ", ")
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}
