// Package ffmpeg shells out to the ffmpeg binary for the single
// operation share-audio needs: stream-copy a [start_ms, end_ms) slice
// of an MP3 into a new file.
//
// Args mirror pipeline.py:_cut byte-for-byte so the output is the same
// MP3 the FastAPI service produced.
package ffmpeg

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

type Cutter struct {
	Bin string
}

func (c Cutter) Cut(ctx context.Context, src, dst string, startMs, endMs int64) error {
	startS := float64(startMs) / 1000
	durS := float64(endMs-startMs) / 1000
	args := []string{
		"-nostdin", "-y",
		"-ss", fmt.Sprintf("%.3f", startS),
		"-i", src,
		"-t", fmt.Sprintf("%.3f", durS),
		"-c", "copy",
		"-loglevel", "error",
		dst,
	}

	cmd := exec.CommandContext(ctx, c.Bin, args...)
	// On ctx cancel, send SIGTERM first (grace), SIGKILL after WaitDelay.
	cmd.WaitDelay = 5 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg cut: %s", msg)
	}
	return nil
}
