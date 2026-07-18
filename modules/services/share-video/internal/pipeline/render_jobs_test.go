package pipeline

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti-share-video/internal/pipeline/reel"
	"github.com/jiva-studio/shruti-share-video/internal/pipeline/transcript"
	"github.com/jiva-studio/shruti-share-video/internal/types"
)

// cachingTranscriber memoizes ASR results by audio content hash, so
// layout iterations don't re-hit OpenRouter for the same (deterministic)
// trimmed clip.
type cachingTranscriber struct {
	inner transcript.Transcriber
	dir   string
}

func (c cachingTranscriber) Transcribe(ctx context.Context, audioPath string, opts transcript.Options) (transcript.Result, error) {
	b, err := os.ReadFile(audioPath)
	if err != nil {
		return c.inner.Transcribe(ctx, audioPath, opts)
	}
	sum := sha256.Sum256(b)
	cf := filepath.Join(c.dir, hex.EncodeToString(sum[:])[:16]+".json")
	if raw, err := os.ReadFile(cf); err == nil {
		var r transcript.Result
		if json.Unmarshal(raw, &r) == nil && len(r.Words) > 0 {
			return r, nil
		}
	}
	r, err := c.inner.Transcribe(ctx, audioPath, opts)
	if err != nil {
		return r, err
	}
	_ = os.MkdirAll(c.dir, 0o755)
	if raw, e := json.Marshal(r); e == nil {
		_ = os.WriteFile(cf, raw, 0o644)
	}
	return r, nil
}

type jobWord struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type renderJob struct {
	VideoID           string    `json:"video_id"`
	OutName           string    `json:"out_name"`
	SourceKey         string    `json:"source_key"`
	Theme             string    `json:"theme"`
	EndMs             int64     `json:"end_ms"`
	Header            string    `json:"header"`
	Sub               string    `json:"sub"`
	ShlokaIAST        string    `json:"shloka_iast"`
	ShlokaTranslation string    `json:"shloka_translation"`
	Text              string    `json:"text"`
	Words             []jobWord `json:"words"`
	Normalize         bool      `json:"normalize"`
	TrimSilence       bool      `json:"trim_silence"`
}

// wordsTranscriber returns fixed recognizer word timings (built upstream
// from the real sentence-level transcript), so the real ForceAlign path
// runs without any external ASR.
type wordsTranscriber struct{ words []transcript.Word }

func (w wordsTranscriber) Transcribe(ctx context.Context, _ string, _ transcript.Options) (transcript.Result, error) {
	return transcript.Result{Words: w.words}, nil
}

// TestRenderJobs renders real Daily Wisdom clips (real Prabhupada audio +
// real backgrounds + real spoken verse) from a staged jobs.json. Gated by
// JOBS_FILE. Backgrounds/src/out roots are <dir(JOBS_FILE)>/{backgrounds,src,out}.
func TestRenderJobs(t *testing.T) {
	jobsFile := os.Getenv("JOBS_FILE")
	if jobsFile == "" {
		t.Skip("set JOBS_FILE to a staged jobs.json")
	}
	root := filepath.Dir(jobsFile)
	ffmpeg := envOr("FFMPEG_BIN", "ffmpeg")
	ffprobe := envOr("FFPROBE_BIN", "ffprobe")

	raw, err := os.ReadFile(jobsFile)
	if err != nil {
		t.Fatalf("read jobs: %v", err)
	}
	var jobs []renderJob
	if err := json.Unmarshal(raw, &jobs); err != nil {
		t.Fatalf("parse jobs: %v", err)
	}

	wd, _ := os.Getwd()
	assets := filepath.Join(wd, "..", "..", "assets")
	fonts := reel.NewFontLoader(filepath.Join(assets, "fonts", "NotoSans-Bold.ttf"))
	iconPath := filepath.Join(assets, "icon.png")
	logoPath := filepath.Join(assets, "logo.mp4")

	// Prefer the REAL OpenRouter transcriber when a key is present — then
	// Render transcribes the cut audio for genuine per-word timings. Falls
	// back to the job's injected words only when no key is set.
	var realTx transcript.Transcriber
	if key := os.Getenv("OPENROUTER_API_KEY"); key != "" {
		tx, err := transcript.New(transcript.Config{
			APIKey:  key,
			BaseURL: envOr("TRANSCRIBE_BASE_URL", "https://openrouter.ai/api/v1"),
			Model:   envOr("TRANSCRIBE_MODEL", "openai/whisper-large-v3"),
		})
		if err != nil {
			t.Fatalf("build transcriber: %v", err)
		}
		realTx = cachingTranscriber{inner: tx, dir: filepath.Join(root, "asr-cache")}
		t.Logf("using REAL OpenRouter transcriber (%s) + content-hash cache", envOr("TRANSCRIBE_MODEL", "openai/whisper-large-v3"))
	}

	for _, j := range jobs {
		words := make([]transcript.Word, len(j.Words))
		for i, w := range j.Words {
			words[i] = transcript.Word{Word: w.Word, Start: w.Start, End: w.End}
		}
		tx := realTx
		if tx == nil {
			tx = wordsTranscriber{words: words}
		}
		r := &Renderer{
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

		var center *types.CenterSection
		if strings.TrimSpace(j.ShlokaIAST) != "" {
			center = &types.CenterSection{Enabled: true, Shloka: &types.Shloka{
				IAST: j.ShlokaIAST, Translation: j.ShlokaTranslation}}
		}
		var brand *types.BrandSpec
		if pos := os.Getenv("BRAND_POS"); pos != "" {
			brand = &types.BrandSpec{Enabled: true, Text: envOr("BRAND_TEXT", "Shruti"), Position: pos}
		}
		in := Input{
			VideoID: j.VideoID,
			TempDir: t.TempDir(),
			Request: types.RenderRequest{
				SourceKey: j.SourceKey,
				StartMs:   0,
				EndMs:     j.EndMs,
				Text:      j.Text,
				Lang:      "en",
				Theme:     j.Theme,
				Audio:     &types.AudioOptions{Normalize: j.Normalize, TrimSilence: j.TrimSilence},
				Layout: &types.Layout{
					Intro: &types.IntroSpec{Enabled: false},
					Outro: &types.OutroSpec{Enabled: false},
					Brand: brand,
					Sections: &types.Sections{
						Header:     &types.HeaderSection{Enabled: true, Text: j.Header, Sub: j.Sub},
						Center:     center,
						Transcript: &types.TranscriptSection{Enabled: true},
					},
				},
			},
		}
		out, err := r.Render(context.Background(), in)
		if err != nil {
			t.Fatalf("render %s: %v", j.VideoID, err)
		}
		path := strings.TrimPrefix(out.URL, "file://")
		dur, _ := ProbeDuration(context.Background(), ffprobe, path)
		if b, e := os.ReadFile(path); e == nil {
			_ = os.WriteFile(filepath.Join(root, j.OutName), b, 0o644)
		}
		t.Logf("%s -> %s (%.1fs)", j.VideoID, filepath.Join(root, j.OutName), dur)
	}
}
