package pipeline

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium-share-video/internal/pipeline/reel"
	"github.com/jiva-studio/lectorium-share-video/internal/pipeline/transcript"
	"github.com/jiva-studio/lectorium-share-video/internal/types"
)

// stubTranscriber spreads the caller text evenly across the probed audio
// duration, so ForceAlign has clean word timings to lock onto — no
// external ASR needed for a local karaoke render.
type stubTranscriber struct {
	ffprobe string
	text    string
}

func (s stubTranscriber) Transcribe(ctx context.Context, audioPath string, _ transcript.Options) (transcript.Result, error) {
	dur, err := ProbeDuration(ctx, s.ffprobe, audioPath)
	if err != nil {
		return transcript.Result{}, err
	}
	words := strings.Fields(s.text)
	if len(words) == 0 || dur <= 0 {
		return transcript.Result{}, nil
	}
	per := dur / float64(len(words))
	res := transcript.Result{Text: s.text}
	for i, w := range words {
		res.Words = append(res.Words, transcript.Word{
			Word:  w,
			Start: float64(i) * per,
			End:   float64(i+1) * per,
		})
	}
	return res, nil
}

// TestLocalRender_Integration drives the real Render() pipeline end-to-end
// against local files (no S3/DB/Redis). Gated by LOCAL_RENDER_OUT, which
// must point at the prepared data root containing:
//
//	backgrounds/<theme>/*.mp4, src/<sourceKey>, out/  (out is written)
//
// Run:
//
//	LOCAL_RENDER_OUT=<root> FFMPEG_BIN=... FFPROBE_BIN=... \
//	  go test ./internal/pipeline -run TestLocalRender_Integration -v
func TestLocalRender_Integration(t *testing.T) {
	root := os.Getenv("LOCAL_RENDER_OUT")
	if root == "" {
		t.Skip("set LOCAL_RENDER_OUT to the prepared data root")
	}
	ffmpeg := envOr("FFMPEG_BIN", "ffmpeg")
	ffprobe := envOr("FFPROBE_BIN", "ffprobe")

	wd, _ := os.Getwd() // internal/pipeline
	assets := filepath.Join(wd, "..", "..", "assets")
	fonts := reel.NewFontLoader(filepath.Join(assets, "fonts", "NotoSans-Bold.ttf"))
	iconPath := filepath.Join(assets, "icon.png")
	logoPath := filepath.Join(assets, "logo.mp4")

	newRenderer := func(tx transcript.Transcriber) *Renderer {
		return &Renderer{
			Transcriber: tx,
			Frames:      &reel.Renderer{Fonts: fonts, IconPNG: iconPath, Opts: reel.Options{SlideWidth: 720, SlideHeight: 1280, FontSize: 53}},
			Composer:    reel.Composer{FFmpegBin: ffmpeg},
			FFmpegBin:   ffmpeg,
			FFprobeBin:  ffprobe,
			Bucket:      "local",
			LogoPath:    logoPath,

			LocalBackgroundsDir: filepath.Join(root, "backgrounds"),
			LocalSourceDir:      filepath.Join(root, "src"),
			LocalOutputDir:      filepath.Join(root, "out"),
		}
	}

	shloka := &types.Shloka{
		IAST:        "mātrā-sparśās tu kaunteya śītoṣṇa-sukha-duḥkha-dāḥ",
		Translation: "O son of Kuntī, the contact of the senses gives rise to heat and cold, pleasure and pain.",
	}

	// --- Run 1: transcript OFF (header + shloka overlay), audio cleanup on.
	off := Input{
		VideoID: "off1",
		TempDir: t.TempDir(),
		Request: types.RenderRequest{
			SourceKey: "public/tracks/demo/clip.mp3",
			StartMs:   0,
			EndMs:     10000,
			Lang:      "en",
			Theme:     "sunrise",
			Audio:     &types.AudioOptions{Normalize: true, TrimSilence: true},
			Layout: &types.Layout{
				Intro: &types.IntroSpec{Enabled: true, Title: "Why do we suffer?", Icon: true},
				Outro: &types.OutroSpec{Enabled: true},
				Sections: &types.Sections{
					Header:     &types.HeaderSection{Enabled: true, Text: "Why do we suffer?", Sub: "Bhagavad-gītā 2.14"},
					Center:     &types.CenterSection{Enabled: true, Shloka: shloka},
					Transcript: &types.TranscriptSection{Enabled: false},
				},
			},
		},
	}
	out1, err := newRenderer(nil).Render(context.Background(), off)
	if err != nil {
		t.Fatalf("render (transcript off): %v", err)
	}
	dur1 := assertReel(t, ffprobe, root, out1, "off1.mp4")
	t.Logf("transcript-OFF reel: %s (%.2fs) — trimmed from 10s source", out1.URL, dur1)

	// --- Run 2: full 3-zone with karaoke transcript (stub ASR).
	text := "the contact of the senses gives rise to heat and cold pleasure and pain they come and go"
	on := Input{
		VideoID: "on1",
		TempDir: t.TempDir(),
		Request: types.RenderRequest{
			SourceKey: "public/tracks/demo/clip.mp3",
			StartMs:   0,
			EndMs:     10000,
			Text:      text,
			Lang:      "en",
			Theme:     "sunrise",
			Audio:     &types.AudioOptions{Normalize: true, TrimSilence: false},
			Layout: &types.Layout{
				Outro: &types.OutroSpec{Enabled: false},
				Sections: &types.Sections{
					Header:     &types.HeaderSection{Enabled: true, Text: "One lesson from the Gita", Sub: ""},
					Center:     &types.CenterSection{Enabled: true, Shloka: shloka},
					Transcript: &types.TranscriptSection{Enabled: true},
				},
			},
		},
	}
	out2, err := newRenderer(stubTranscriber{ffprobe: ffprobe, text: text}).Render(context.Background(), on)
	if err != nil {
		t.Fatalf("render (transcript on): %v", err)
	}
	dur2 := assertReel(t, ffprobe, root, out2, "on1.mp4")
	t.Logf("transcript-ON reel:  %s (%.2fs)", out2.URL, dur2)
}

func assertReel(t *testing.T, ffprobe, root string, out Output, copyName string) float64 {
	t.Helper()
	path := strings.TrimPrefix(out.URL, "file://")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("output %s: %v", path, err)
	}
	if info.Size() < 10_000 {
		t.Fatalf("output suspiciously small: %d bytes", info.Size())
	}
	dur, err := ProbeDuration(context.Background(), ffprobe, path)
	if err != nil {
		t.Fatalf("probe output: %v", err)
	}
	if dur <= 0 {
		t.Fatalf("output has no duration")
	}
	// Copy to a stable name at the root for eyeballing.
	if b, err := os.ReadFile(path); err == nil {
		_ = os.WriteFile(filepath.Join(root, copyName), b, 0o644)
	}
	return dur
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
