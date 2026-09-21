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

// MaxSourceDuration caps the source audio at four hours — longer than
// any real lecture and well past the cut-window the API accepts.
// Anything larger is either a configuration mistake or a misclassified
// non-audio object.
const MaxSourceDuration = 4 * 60 * 60.0

// ValidateAudioInfo rejects ProbeAudio results that look like something
// other than an MP3 (or m4a) audio file the renderer is willing to
// hand to ffmpeg. Run on the downloaded source before any ffmpeg
// invocation — keeps misclassified objects and obscure formats out of
// the binary's parser surface.
func ValidateAudioInfo(info AudioInfo) error {
	// ffprobe's format_name is a comma-separated list of candidates;
	// mp3 stays "mp3", mp4-family is "mov,mp4,m4a,3gp,3g2,mj2".
	allowedFormat := false
	for _, name := range strings.Split(info.Format, ",") {
		switch name {
		case "mp3", "mp4", "m4a":
			allowedFormat = true
		}
	}
	if !allowedFormat {
		return fmt.Errorf("unsupported source format %q (expected mp3 or m4a)", info.Format)
	}
	switch info.AudioCodec {
	case "mp3", "aac":
		// ok
	default:
		return fmt.Errorf("unsupported audio codec %q (expected mp3 or aac)", info.AudioCodec)
	}
	if info.Duration <= 0 {
		return fmt.Errorf("source has no audio duration")
	}
	if info.Duration > MaxSourceDuration {
		return fmt.Errorf("source duration %.1fs exceeds cap %.0fs", info.Duration, MaxSourceDuration)
	}
	return nil
}

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
	info, err := ProbeAudio(ctx, ffprobeBin, path)
	if err != nil {
		return 0, err
	}
	return info.Duration, nil
}

// AudioInfo carries the fields ProbeAudio returns. Format is ffprobe's
// `format_name` (e.g. "mp3", or the mp4-family "mov,mp4,m4a,3gp,3g2,mj2");
// AudioCodec is the codec of the first audio stream (e.g. "mp3", "aac").
type AudioInfo struct {
	Format     string
	Duration   float64
	AudioCodec string
}

// ProbeAudio inspects `path` and returns format / duration / first
// audio-stream codec. Used as a pre-flight gate before invoking
// ffmpeg on user-influenced inputs — see ValidateAudioInfo.
func ProbeAudio(ctx context.Context, ffprobeBin, path string) (AudioInfo, error) {
	args := []string{
		"-v", "error",
		"-show_entries", "format=duration,format_name:stream=codec_type,codec_name",
		"-of", "json",
		path,
	}
	cmd := exec.CommandContext(ctx, ffprobeBin, args...)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return AudioInfo{}, fmt.Errorf("ffprobe %s: %w", path, err)
	}
	var parsed struct {
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return AudioInfo{}, fmt.Errorf("parse ffprobe output: %w", err)
	}
	info := AudioInfo{Format: parsed.Format.FormatName}
	if parsed.Format.Duration != "" {
		d, err := strconv.ParseFloat(parsed.Format.Duration, 64)
		if err != nil {
			return AudioInfo{}, fmt.Errorf("parse duration %q: %w", parsed.Format.Duration, err)
		}
		info.Duration = d
	}
	for _, s := range parsed.Streams {
		if s.CodecType == "audio" {
			info.AudioCodec = s.CodecName
			break
		}
	}
	return info, nil
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
// quotes: a single quote becomes `'\”`. Matches the JS regex from
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
