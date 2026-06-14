// Package execdenoise runs the audio-denoiser script as a subprocess —
// the same local-tool pattern as the ffmpeg normalizer.
package execdenoise

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
