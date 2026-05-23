package pipeline

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
	"time"
)

// CutAudio stream-copies [startMs, endMs) out of src into dst as MP3.
// Same invocation as share-audio.
func CutAudio(ctx context.Context, ffmpegBin, src, dst string, startMs, endMs int64) error {
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
	return runFFmpeg(ctx, ffmpegBin, args)
}

// ProbeDuration returns the duration of `path` in seconds, using
// ffprobe with json output. Matches videoBackgrounds.ts:getVideoDuration
// semantics; missing duration → 0 (caller's responsibility to validate).
func ProbeDuration(ctx context.Context, ffprobeBin, path string) (float64, error) {
	args := []string{
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "json",
		path,
	}
	cmd := exec.CommandContext(ctx, ffprobeBin, args...)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("ffprobe %s: %w", path, err)
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return 0, fmt.Errorf("parse ffprobe output: %w", err)
	}
	if parsed.Format.Duration == "" {
		return 0, nil
	}
	d, err := strconv.ParseFloat(parsed.Format.Duration, 64)
	if err != nil {
		return 0, fmt.Errorf("parse duration %q: %w", parsed.Format.Duration, err)
	}
	return d, nil
}

// concatClips concatenates pre-normalised background clips with the
// concat demuxer (stream-copy + -an drops audio). Truncates to
// targetDurationSec via -t, then writes outPath. Mirrors
// videoBackgrounds.ts:concatClips.
func concatClips(ctx context.Context, ffmpegBin string, clipPaths []string, targetDurationSec float64, outPath, tempDir string) error {
	if len(clipPaths) == 0 {
		return fmt.Errorf("concatClips: no clips supplied")
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	listPath := filepath.Join(tempDir, "bg_list.txt")
	var lines []string
	for _, p := range clipPaths {
		lines = append(lines, "file '"+escapeConcatPath(p)+"'")
	}
	if err := os.WriteFile(listPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return err
	}

	args := []string{
		"-nostdin", "-y",
		"-f", "concat", "-safe", "0",
		"-i", listPath,
		"-t", strconv.FormatFloat(targetDurationSec, 'f', 3, 64),
		"-c", "copy",
		"-an",
		"-loglevel", "warning",
		outPath,
	}
	return runFFmpeg(ctx, ffmpegBin, args)
}

// escapeConcatPath is what the concat demuxer expects inside single
// quotes: a single quote becomes `'\''`. Matches the JS regex from
// videoBackgrounds.ts:52.
func escapeConcatPath(p string) string {
	return strings.ReplaceAll(p, "'", `'\''`)
}

// runFFmpeg shells out, captures stderr (so failures include the ffmpeg
// error line in the error message instead of just "exit status 1"),
// and uses CommandContext so a ctx cancel kills the subprocess.
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
