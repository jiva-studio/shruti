package ffmpeg

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/loudness"
)

// Tool wraps ffmpeg+ffprobe binaries. Implements both loudness.Normalizer and audio.Probe.
type Tool struct {
	FFmpegBin  string // "ffmpeg"
	FFprobeBin string // derived: same dir, "ffprobe"
}

func New(ffmpegBin string) *Tool {
	probe := "ffprobe"
	if dir := filepath.Dir(ffmpegBin); dir != "" && dir != "." {
		probe = filepath.Join(dir, "ffprobe")
		if _, err := os.Stat(probe); err != nil {
			probe = "ffprobe"
		}
	}
	return &Tool{FFmpegBin: ffmpegBin, FFprobeBin: probe}
}

// Probe implements audio.Probe via ffprobe -of json.
func (t *Tool) Probe(ctx context.Context, path string) (audioport.Info, error) {
	cmd := exec.CommandContext(ctx, t.FFprobeBin,
		"-v", "error",
		"-print_format", "json",
		"-show_format", "-show_streams",
		path,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return audioport.Info{}, fmt.Errorf("ffprobe %s: %w (stderr: %s)", path, err, stderr.String())
	}
	var raw struct {
		Format struct {
			Duration string `json:"duration"`
			Size     string `json:"size"`
			BitRate  string `json:"bit_rate"`
		} `json:"format"`
		Streams []struct {
			CodecType  string `json:"codec_type"`
			Channels   int    `json:"channels"`
			SampleRate string `json:"sample_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &raw); err != nil {
		return audioport.Info{}, fmt.Errorf("ffprobe json: %w", err)
	}
	dur, _ := strconv.ParseFloat(raw.Format.Duration, 64)
	size, _ := strconv.ParseInt(raw.Format.Size, 10, 64)
	br, _ := strconv.Atoi(raw.Format.BitRate)
	info := audioport.Info{
		DurationMs: int64(dur * 1000),
		Bitrate:    br / 1000, // ffprobe gives bps; report kbps
		SizeBytes:  size,
	}
	for _, s := range raw.Streams {
		if s.CodecType == "audio" {
			info.Channels = s.Channels
			info.SampleRate, _ = strconv.Atoi(s.SampleRate)
			break
		}
	}
	return info, nil
}

// Normalize implements loudness.Normalizer.
//
// Re-encodes to 128 kbps CBR MP3 LAME. No loudness/dynamic-range processing
// (would amplify noise on archival lecture material). Channels preserved
// from the source. The 128 kbps target matches the historical canonical
// bitrate that fixed mobile player glitches.
func (t *Tool) Normalize(ctx context.Context, in, out string) (loudness.Report, error) {
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return loudness.Report{}, fmt.Errorf("mkdir %s: %w", filepath.Dir(out), err)
	}

	args := []string{
		"-y", "-hide_banner", "-loglevel", "info",
		"-i", in,
		"-c:a", "libmp3lame", "-b:a", "128k",
		out,
	}

	cmd := exec.CommandContext(ctx, t.FFmpegBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return loudness.Report{}, fmt.Errorf("ffmpeg %s: %w (stderr tail: %s)", in, err, tailString(stderr.String(), 800))
	}

	report := loudness.Report{}
	post, err := t.Probe(ctx, out)
	if err == nil {
		report.Bitrate = post.Bitrate
		report.DurationMs = post.DurationMs
	}
	return report, nil
}

func tailString(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}
