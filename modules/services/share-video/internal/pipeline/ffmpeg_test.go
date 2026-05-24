package pipeline

import (
	"strings"
	"testing"
)

func TestValidateAudioInfo_AcceptsMP3(t *testing.T) {
	if err := ValidateAudioInfo(AudioInfo{
		Format:     "mp3",
		Duration:   1234.5,
		AudioCodec: "mp3",
	}); err != nil {
		t.Fatalf("mp3 should be accepted, got %v", err)
	}
}

func TestValidateAudioInfo_AcceptsM4A(t *testing.T) {
	// ffprobe reports the mp4-family format_name as a comma-separated
	// list of candidates; the validator should accept any member that
	// names mp4/m4a.
	if err := ValidateAudioInfo(AudioInfo{
		Format:     "mov,mp4,m4a,3gp,3g2,mj2",
		Duration:   60,
		AudioCodec: "aac",
	}); err != nil {
		t.Fatalf("m4a should be accepted, got %v", err)
	}
}

func TestValidateAudioInfo_RejectsUnknownFormat(t *testing.T) {
	err := ValidateAudioInfo(AudioInfo{
		Format:     "matroska,webm",
		Duration:   60,
		AudioCodec: "opus",
	})
	if err == nil || !strings.Contains(err.Error(), "format") {
		t.Fatalf("expected format rejection, got %v", err)
	}
}

func TestValidateAudioInfo_RejectsUnknownCodec(t *testing.T) {
	err := ValidateAudioInfo(AudioInfo{
		Format:     "mp3",
		Duration:   60,
		AudioCodec: "flac",
	})
	if err == nil || !strings.Contains(err.Error(), "codec") {
		t.Fatalf("expected codec rejection, got %v", err)
	}
}

func TestValidateAudioInfo_RejectsZeroDuration(t *testing.T) {
	err := ValidateAudioInfo(AudioInfo{
		Format:     "mp3",
		Duration:   0,
		AudioCodec: "mp3",
	})
	if err == nil || !strings.Contains(err.Error(), "duration") {
		t.Fatalf("expected duration rejection, got %v", err)
	}
}

func TestValidateAudioInfo_RejectsTooLong(t *testing.T) {
	err := ValidateAudioInfo(AudioInfo{
		Format:     "mp3",
		Duration:   MaxSourceDuration + 1,
		AudioCodec: "mp3",
	})
	if err == nil || !strings.Contains(err.Error(), "cap") {
		t.Fatalf("expected over-cap rejection, got %v", err)
	}
}
