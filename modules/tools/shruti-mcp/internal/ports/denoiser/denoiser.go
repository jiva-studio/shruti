// Package denoiser is the port for producing a denoised "clean" mp3 from an
// original. The fs/exec adapter shells out to the audio-denoiser script.
package denoiser

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/denoiseplan"
)

type Denoiser interface {
	// Denoise reads the mp3 at inPath and writes a denoised mp3 to outPath
	// (creating parent dirs). Synchronous; returns on completion or error.
	Denoise(ctx context.Context, inPath, outPath string) error

	// DenoisePlan denoises inPath to outPath using a splice plan — each segment
	// cleaned with its own strategy, then concatenated with one loudness pass.
	// Used to protect sung kirtan / recited regions from the speech denoiser.
	DenoisePlan(ctx context.Context, inPath, outPath string, plan []denoiseplan.Segment, crossfadeMs int) error
}
