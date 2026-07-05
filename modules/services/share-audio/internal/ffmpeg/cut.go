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
	"strings"
	"time"
)

type Cutter struct {
	Bin string
}

// Cut trims a [start_ms, end_ms) slice out of src into dst via stream-copy.
// src may be a local path or an http(s) URL: with -ss BEFORE -i, ffmpeg
// issues a Range request and reads only the bytes around the excerpt
// instead of pulling the whole (often 100+ MB) source track.
func (c Cutter) Cut(ctx context.Context, src, dst string, startMs, endMs int64) error {
	startS := float64(startMs) / 1000
	durS := float64(endMs-startMs) / 1000
	args := []string{"-nostdin", "-y"}
	// Remote inputs: survive transient CDN drops mid-fetch instead of
	// failing the whole cut. These are http-protocol options, so only add
	// them for URL inputs (ffmpeg errors on them for a plain file path).
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
	}
	args = append(args,
		"-ss", fmt.Sprintf("%.3f", startS),
		"-i", src,
		"-t", fmt.Sprintf("%.3f", durS),
		"-c", "copy",
		"-loglevel", "error",
		dst,
	)

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
