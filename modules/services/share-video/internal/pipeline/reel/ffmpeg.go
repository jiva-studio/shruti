package reel

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// FFmpegBin / FFprobeBin are passed via the Composer struct. We don't
// look at env directly here so tests can drive the path.

// Composer drives the three ffmpeg passes that turn (background video,
// text PNG frames, cut audio, optional logo) into the final MP4.
type Composer struct {
	FFmpegBin string
}

// Compose runs the full render — Pass 1 (qtrle text track) → Pass 2
// (composite + audio) → Pass 3 (logo append, if logoPath != ""). The
// final MP4 lands at outputPath.
func (c Composer) Compose(
	ctx context.Context,
	backgroundVideo string,
	frames []FrameSpec,
	audio string,
	audioDuration float64,
	logoPath string,
	outputPath string,
	tempDir string,
) error {
	if len(frames) == 0 {
		return fmt.Errorf("compose: no frames")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return err
	}

	// Pass 1: build the transparent QuickTime text track.
	textConcatPath := filepath.Join(tempDir, "text_concat.txt")
	textVideoPath := filepath.Join(tempDir, "text_overlay.mov")
	if err := writeTextConcatList(textConcatPath, frames, audioDuration); err != nil {
		return fmt.Errorf("write text concat list: %w", err)
	}
	if err := c.runTextTrack(ctx, textConcatPath, textVideoPath); err != nil {
		return fmt.Errorf("text track: %w", err)
	}

	// Pass 2: composite background + text + audio with libx264 + AAC.
	compositePath := outputPath
	if logoPath != "" {
		compositePath = filepath.Join(tempDir, "reel_no_logo.mp4")
	}
	if err := c.runComposite(ctx, backgroundVideo, textVideoPath, audio, compositePath); err != nil {
		return fmt.Errorf("composite: %w", err)
	}

	// Pass 3 (optional): append logo via concat demuxer with stream-copy.
	if logoPath != "" {
		if err := c.runAppendLogo(ctx, compositePath, logoPath, outputPath, tempDir); err != nil {
			return fmt.Errorf("append logo: %w", err)
		}
	}
	return nil
}

// writeTextConcatList materialises the concat-demuxer list for the
// PNG frames. The list shape is the same as ReelGenerator.ts:194-211 —
// frame paths quoted and last frame repeated so the demuxer accepts the
// final duration.
func writeTextConcatList(path string, frames []FrameSpec, audioDuration float64) error {
	var lines []string
	first := frames[0]
	// Leading silence before the first word: hold the first frame from
	// 0 to its startTime. If the title-frame path is used the first
	// frame's startTime is 0 and this branch is skipped.
	if first.StartTime > 0 {
		lines = append(lines,
			"file '"+escapeConcatPath(first.Path)+"'",
			fmt.Sprintf("duration %.6f", first.StartTime),
		)
	}
	for i, cur := range frames {
		var display float64
		if i+1 < len(frames) {
			next := frames[i+1]
			// next.startTime - cur.startTime is how long this frame is on
			// screen; cur.Duration alone might overlap with the next.
			display = cur.Duration + (next.StartTime - (cur.StartTime + cur.Duration))
		} else {
			display = audioDuration - cur.StartTime
		}
		if display < 0.001 {
			display = 0.001
		}
		lines = append(lines,
			"file '"+escapeConcatPath(cur.Path)+"'",
			fmt.Sprintf("duration %.6f", display),
		)
	}
	// Repeat the last frame so the concat demuxer accepts the trailing
	// duration line — quirk of the format.
	lines = append(lines, "file '"+escapeConcatPath(frames[len(frames)-1].Path)+"'")
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644)
}

// runTextTrack: PNG list → qtrle .mov (lossless, alpha-preserving).
// -vsync vfr keeps the text track variable-framerate so the demuxer
// doesn't pad with repeated frames.
func (c Composer) runTextTrack(ctx context.Context, listPath, outPath string) error {
	args := []string{
		"-nostdin", "-y",
		"-f", "concat", "-safe", "0",
		"-i", listPath,
		"-c:v", "qtrle",
		"-vsync", "vfr",
		"-loglevel", "warning",
		outPath,
	}
	return runFFmpeg(ctx, c.FFmpegBin, args)
}

// runComposite: overlay text track on background, mix audio, encode
// with libx264 + AAC at fixed 30 fps / 44.1 kHz stereo so the logo
// append (Pass 3) can stream-copy without codec mismatch.
func (c Composer) runComposite(ctx context.Context, bg, text, audio, outPath string) error {
	args := []string{
		"-nostdin", "-y",
		"-i", bg,
		"-i", text,
		"-i", audio,
		"-filter_complex",
		"[0:v]setpts=PTS-STARTPTS[bg];" +
			"[1:v]setpts=PTS-STARTPTS[txt];" +
			"[bg][txt]overlay=0:0:shortest=0:repeatlast=1[outv]",
		"-map", "[outv]",
		"-map", "2:a",
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-tune", "zerolatency",
		"-crf", "23",
		"-pix_fmt", "yuv420p",
		"-r", "30",
		"-c:a", "aac",
		"-ar", "44100",
		"-ac", "2",
		"-shortest",
		"-loglevel", "warning",
		outPath,
	}
	return runFFmpeg(ctx, c.FFmpegBin, args)
}

// runAppendLogo: concat-demuxer stream-copy. Works only because the
// composite step pinned identical codec params (h264/yuv420p/30fps/
// AAC/44.1k/stereo). If a future logo regen drifts, the demuxer
// errors with "non-monotonous DTS" and we'd need a probe-and-reencode
// fallback.
func (c Composer) runAppendLogo(ctx context.Context, main, logo, out, tempDir string) error {
	listPath := filepath.Join(tempDir, "logo_concat.txt")
	lines := []string{
		"file '" + escapeConcatPath(main) + "'",
		"file '" + escapeConcatPath(logo) + "'",
	}
	if err := os.WriteFile(listPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return err
	}
	args := []string{
		"-nostdin", "-y",
		"-f", "concat", "-safe", "0",
		"-i", listPath,
		"-c", "copy",
		"-movflags", "+faststart",
		"-loglevel", "warning",
		out,
	}
	return runFFmpeg(ctx, c.FFmpegBin, args)
}

func escapeConcatPath(p string) string {
	return strings.ReplaceAll(p, "'", `'\''`)
}

func runFFmpeg(ctx context.Context, bin string, args []string) error {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.WaitDelay = 5 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg: %s", msg)
	}
	return nil
}

