// Package alignpdf produces a reviewed transcript directly from a canonical
// PDF transcript + raw ASR output, bypassing the LLM review path.
//
// When a track has an authoritative PDF (e.g. Bhaktivedanta Archives English
// lectures), the canonical text is already perfect — we don't need the LLM
// to clean ASR output, we just need to project the ASR timestamps onto the
// canonical sentences/verses. This is faster (no LLM), free (no API cost),
// and produces strictly correct text (no hallucinations).
//
// The use case is invocable two ways:
//   - Standalone via the transcript_align_pdf MCP tool: Run() claims the
//     reviewed stage, does the work, releases.
//   - Inside review.UseCase as the early-branch when prefer=auto+PDF exists:
//     RunInternal() is called WITHOUT claiming (review already holds the lock).
package alignpdf

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	alignpdfport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/alignpdf"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

type UseCase struct {
	Registry    lakeport.Registry
	Transcripts transcriptport.Store
	Aligner     alignpdfport.Aligner
	OutDir      string
}

type Result struct {
	TrackId  track.Id `json:"track_id"`
	Language string   `json:"language"`
	Method   string   `json:"method"` // always "pdf"
	Blocks   int      `json:"blocks"`
	PDFPath  string   `json:"pdf_path"`
	RawPath  string   `json:"raw_path"`
}

// PDFPath returns the canonical lake path where the PDF transcript should
// live for a given track. Existence is the caller's responsibility (use
// PDFExists()).
func PDFPath(outDir string, id track.Id) string {
	return filepath.Join(outDir, "artifacts", "tracks", string(id), "transcript.pdf")
}

// RawPath returns the canonical lake path of the raw ASR JSON for a given
// track and language.
func RawPath(outDir string, id track.Id, language string) string {
	return filepath.Join(outDir, "artifacts", "tracks", string(id), "transcripts", language, "raw.json")
}

// PDFExists reports whether transcript.pdf is present for this track.
// Used by review.Run to decide auto vs LLM path.
// TextPath is the home of a proofread transcript shipped by the importer.
func TextPath(outDir string, id track.Id) string {
	return filepath.Join(outDir, "artifacts", "tracks", string(id), "transcript.html")
}

// TextExists reports whether the track has one.
func TextExists(outDir string, id track.Id) bool {
	_, err := os.Stat(TextPath(outDir, id))
	return err == nil
}

func PDFExists(outDir string, id track.Id) bool {
	if _, err := os.Stat(PDFPath(outDir, id)); err == nil {
		return true
	}
	return false
}

// Run claims the reviewed stage, runs the alignment, writes the reviewed
// transcript, and marks the stage done. Use this when invoked standalone
// (e.g. transcript_align_pdf MCP tool); when called from inside review
// where the stage is already claimed, use RunInternal instead.
func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageReviewed, Variant: language}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("alignpdf: another worker holds reviewed stage for %s/%s", id, language)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	res, err = uc.RunInternal(ctx, id, language)
	if err != nil {
		return Result{}, err
	}

	resBody, _ := json.Marshal(res)
	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, resBody, ""); err != nil {
		return Result{}, err
	}
	return res, nil
}

// RunInternal performs the alignment + persistence WITHOUT claiming the
// stage. Caller must already hold pipeline.StageReviewed for (id, language)
// and is responsible for marking the stage done.
//
// This is the entry point review.UseCase uses when forking on prefer=pdf.
func (uc UseCase) RunInternal(ctx context.Context, id track.Id, language string) (Result, error) {
	if uc.Aligner == nil {
		return Result{}, fmt.Errorf("alignpdf: aligner not configured (set review.align_pdf.script_path in config)")
	}
	pdfPath, textPath := PDFPath(uc.OutDir, id), ""
	if _, err := os.Stat(pdfPath); err != nil {
		pdfPath = ""
		if textPath = TextPath(uc.OutDir, id); !TextExists(uc.OutDir, id) {
			return Result{}, fmt.Errorf("alignpdf: no canonical transcript for %s (neither transcript.pdf nor transcript.html)", id)
		}
	}
	rawPath := RawPath(uc.OutDir, id, language)
	if _, err := os.Stat(rawPath); err != nil {
		return Result{}, fmt.Errorf("alignpdf: raw transcript not found at %s (run transcript_create first)", rawPath)
	}

	rev, err := uc.Aligner.Align(ctx, alignpdfport.Request{
		PDFPath:  pdfPath,
		TextPath: textPath,
		RawPath:  rawPath,
		Language: language,
	})
	if err != nil {
		return Result{}, fmt.Errorf("alignpdf: align: %w", err)
	}
	// Trust the aligner's wire fields, but force trackId/language to match
	// the request — the Python side reads trackId from raw.json which may
	// disagree (or be empty) under unusual conditions.
	rev.TrackId = string(id)
	rev.Language = language
	if rev.Version == 0 {
		rev.Version = 2
	}

	if err := uc.Transcripts.WriteReviewed(ctx, rev); err != nil {
		return Result{}, fmt.Errorf("alignpdf: write reviewed: %w", err)
	}

	// Audit artifact alongside chunk_NNNN.json files so it's visible
	// next to LLM review sessions for the same track.
	session := map[string]any{
		"track_id":     string(id),
		"language":     language,
		"method":       "pdf_align",
		"pdf_path":     pdfPath,
		"raw_path":     rawPath,
		"blocks":       len(rev.Blocks),
		"reviewed_at":  time.Now().UTC().Format(time.RFC3339),
	}
	if body, err := json.MarshalIndent(session, "", "  "); err == nil {
		_ = uc.Transcripts.WriteReviewSession(ctx, id, language, body)
	}

	return Result{
		TrackId:  id,
		Language: language,
		Method:   "pdf",
		Blocks:   len(rev.Blocks),
		PDFPath:  pdfPath,
		RawPath:  rawPath,
	}, nil
}
