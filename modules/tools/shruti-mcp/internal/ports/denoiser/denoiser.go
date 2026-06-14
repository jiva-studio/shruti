// Package denoiser is the port for producing a denoised "clean" mp3 from an
// original. The fs/exec adapter shells out to the audio-denoiser script.
package denoiser

import "context"

type Denoiser interface {
	// Denoise reads the mp3 at inPath and writes a denoised mp3 to outPath
	// (creating parent dirs). Synchronous; returns on completion or error.
	Denoise(ctx context.Context, inPath, outPath string) error
}
