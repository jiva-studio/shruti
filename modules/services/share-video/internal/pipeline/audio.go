package pipeline

import (
	"context"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti-share-video/internal/types"
)

// Audio-cleanup filter parameters. Deliberately conservative so speech
// rhythm survives: only silences longer than trimStopDuration are removed,
// and normalize targets the EBU R128 loudness the social platforms expect.
const (
	// trimStopThreshold: anything quieter counts as silence.
	trimStopThreshold = "-35dB"
	// trimStopDuration: minimum silent span (seconds) eligible for removal.
	// Below this we keep the pause — natural breaths between phrases stay.
	trimStopDuration = "0.6"
	// loudnorm target integrated loudness / true-peak / range (EBU R128).
	loudnormFilter = "loudnorm=I=-16:TP=-1.5:LRA=11"
	// leadFadeDuration: gentle fade-in (seconds) at the very start so the clip
	// eases in instead of slapping the first word at full volume, and any
	// slight lead-in the caller kept before the word is masked.
	leadFadeDuration = "0.25"
)

// AudioCleanupRequested reports whether opts asks for any processing at
// all — lets the caller skip the extra ffmpeg pass entirely.
func AudioCleanupRequested(opts *types.AudioOptions) bool {
	return opts != nil && (opts.Normalize || opts.TrimSilence)
}

// ProcessAudio re-encodes src → dst (MP3) applying the requested cleanup:
// dead-pause removal (silenceremove) and/or loudness normalize (loudnorm).
// It runs AFTER CutAudio and BEFORE transcription, so every downstream
// word timing refers to the cleaned audio and the caption sync stays
// correct. Callers must only invoke it when AudioCleanupRequested is true.
func ProcessAudio(ctx context.Context, ffmpegBin, src, dst string, opts *types.AudioOptions) error {
	if !AudioCleanupRequested(opts) {
		return fmt.Errorf("ProcessAudio called with no cleanup requested")
	}

	var filters []string
	if opts.TrimSilence {
		// start_periods=0 keeps the caller's short lead-in before the first
		// word (removing it made clips slap in mid-attack); stop_periods=-1
		// still removes every internal silent span meeting the threshold+
		// duration, and the trailing silence via the same stop pass.
		filters = append(filters, fmt.Sprintf(
			"silenceremove=start_periods=0:"+
				"stop_periods=-1:stop_threshold=%s:stop_duration=%s",
			trimStopThreshold, trimStopDuration,
		))
	}
	if opts.Normalize {
		// Normalize AFTER trimming: silence detection uses the original
		// levels; loudnorm then lifts the surviving speech to target.
		filters = append(filters, loudnormFilter)
	}
	// Fade-in last, over the normalized output, so the clip eases in.
	filters = append(filters, fmt.Sprintf("afade=t=in:st=0:d=%s", leadFadeDuration))

	args := []string{
		"-nostdin", "-y",
		"-i", src,
		"-af", strings.Join(filters, ","),
		"-c:a", "libmp3lame",
		"-q:a", "2",
		"-loglevel", "error",
		dst,
	}
	return runFFmpeg(ctx, ffmpegBin, args)
}
