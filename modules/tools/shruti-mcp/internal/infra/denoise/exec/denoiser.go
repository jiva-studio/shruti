// Package execdenoise runs the audio-denoiser script as a subprocess —
// the same local-tool pattern as the ffmpeg normalizer.
package execdenoise

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/denoiseplan"
)

// Tool shells out to denoise_mp3.py (single-file mode: --in/--out).
type Tool struct {
	Python string // interpreter with the denoise deps (e.g. "python3" or a venv)
	Script string // path to audio-denoiser/denoise_mp3.py
}

func New(python, script string) *Tool {
	if python == "" {
		python = "python3"
	}
	return &Tool{Python: python, Script: script}
}

// Denoise runs `python denoise_mp3.py --in <in> --out <out>`. The catalog
// producer intentionally uses the script's default strategy (DeepFilterNet3) —
// that is the canonical "clean" version; strategy selection / A-B tuning lives
// in denoiser-mcp, not in the publish path.
func (t *Tool) Denoise(ctx context.Context, inPath, outPath string) error {
	if t.Script == "" {
		return fmt.Errorf("denoiser: script path not configured")
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("denoiser: mkdir out: %w", err)
	}
	cmd := exec.CommandContext(ctx, t.Python, t.Script, "--in", inPath, "--out", outPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("denoiser: %s %s: %w (stderr: %s)",
			t.Python, t.Script, err, stderr.String())
	}
	return nil
}

// planJSON is the on-disk shape consumed by denoise_mp3.py --plan.
type planJSON struct {
	Segments    []planSegmentJSON `json:"segments"`
	CrossfadeMs int               `json:"crossfade_ms"`
}

type planSegmentJSON struct {
	StartMs  int64    `json:"start_ms"`
	EndMs    int64    `json:"end_ms"`
	Strategy string   `json:"strategy"`
	NR       *float64 `json:"nr,omitempty"`
}

// DenoisePlan runs `python denoise_mp3.py --in <in> --out <out> --plan <file>`,
// where <file> holds the splice plan. Each segment is cleaned with its own
// strategy and the parts are spliced with one loudness pass.
func (t *Tool) DenoisePlan(ctx context.Context, inPath, outPath string, plan []denoiseplan.Segment, crossfadeMs int) error {
	if t.Script == "" {
		return fmt.Errorf("denoiser: script path not configured")
	}
	if len(plan) == 0 {
		return t.Denoise(ctx, inPath, outPath)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("denoiser: mkdir out: %w", err)
	}

	pj := planJSON{CrossfadeMs: crossfadeMs}
	for _, s := range plan {
		pj.Segments = append(pj.Segments, planSegmentJSON{
			StartMs: s.StartMs, EndMs: s.EndMs, Strategy: s.Strategy, NR: s.NR,
		})
	}
	body, err := json.Marshal(pj)
	if err != nil {
		return fmt.Errorf("denoiser: marshal plan: %w", err)
	}
	f, err := os.CreateTemp("", "denoise-plan-*.json")
	if err != nil {
		return fmt.Errorf("denoiser: temp plan: %w", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(body); err != nil {
		f.Close()
		return fmt.Errorf("denoiser: write plan: %w", err)
	}
	f.Close()

	cmd := exec.CommandContext(ctx, t.Python, t.Script, "--in", inPath, "--out", outPath, "--plan", f.Name())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("denoiser: %s %s --plan: %w (stderr: %s)",
			t.Python, t.Script, err, stderr.String())
	}
	return nil
}
