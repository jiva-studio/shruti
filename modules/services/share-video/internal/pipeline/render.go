// Package pipeline orchestrates the steps that turn a RenderRequest +
// task id into a final MP4 sitting in S3. The HTTP layer never calls
// Render directly — the queue worker does.
package pipeline

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"golang.org/x/sync/errgroup"

	"github.com/akdasa-studios/shruti-share-video/internal/logx"
	"github.com/akdasa-studios/shruti-share-video/internal/pipeline/align"
	"github.com/akdasa-studios/shruti-share-video/internal/pipeline/reel"
	"github.com/akdasa-studios/shruti-share-video/internal/pipeline/transcript"
	"github.com/akdasa-studios/shruti-share-video/internal/storage"
	"github.com/akdasa-studios/shruti-share-video/internal/types"
)

// Renderer is the top-level glue. Hand-assembled at worker boot once.
type Renderer struct {
	S3 *s3.Client
	// BunnyOut, when set, receives the finished reel instead of S3 (the
	// client-facing output moves to Bunny; reads + SpeechKit stay on S3).
	BunnyOut          *storage.BunnyUploader
	Transcriber       transcript.Transcriber
	Frames            *reel.Renderer
	Composer          reel.Composer
	FFmpegBin         string
	FFprobeBin        string
	Bucket            string
	BackgroundsPrefix string
	OutputPrefix      string
	OutputPublicBase  string
	Region            string
	LogoPath          string
	TitleIconPath     string
}

// Input is what each task in the queue brings to the renderer.
type Input struct {
	Request types.RenderRequest
	VideoID string
	TempDir string
}

// Output is what the worker writes back to public.tasks.result.
type Output struct {
	URL       string
	OutputKey string
}

// titleOverlayDur matches ReelGenerator.ts:TITLE_DURATION_S. Half a
// second of cream-frame overlay at the start of the reel when a title
// is supplied.
const titleOverlayDur = 0.5

// Render runs the full pipeline. Order matches worker.ts:processOne:
//
//  1. Download source MP3.
//  2. Cut audio to [startMs, endMs).
//  3. Parallel: assemble background MP4 (S3 list + seeded shuffle +
//     download + ffmpeg concat) AND transcribe the cut audio.
//  4. Force-align caller text to the recogniser's word timings.
//  5. Render per-word PNG frames (or a single frame per slide when
//     timings are absent / collapsed).
//  6. Insert title-card frame on top of the first 0.5s (optional).
//  7. ffmpeg Pass 1 (qtrle), Pass 2 (composite), optional Pass 3
//     (logo append). PutObject the result.
func (r *Renderer) Render(ctx context.Context, in Input) (Output, error) {
	log := logx.From(ctx)
	start := time.Now()

	srcPath := filepath.Join(in.TempDir, "source.mp3")
	cutPath := filepath.Join(in.TempDir, "cut.mp3")

	log.Info("source_download_start", "bucket", r.Bucket, "key", in.Request.SourceKey)
	if err := r.downloadSource(ctx, in.Request.SourceKey, srcPath); err != nil {
		return Output{}, fmt.Errorf("source download: %w", err)
	}

	// Pre-flight: probe the downloaded source and reject anything that
	// doesn't look like an mp3/m4a audio file BEFORE the first ffmpeg
	// invocation. sourceKey is regex-gated at the API layer
	// (httpx/validate.go: public/(tracks|shares)/...mp3) but content
	// can drift from the path; this stops misclassified objects
	// reaching ffmpeg's format parsers.
	srcInfo, err := ProbeAudio(ctx, r.FFprobeBin, srcPath)
	if err != nil {
		return Output{}, fmt.Errorf("source probe: %w", err)
	}
	if err := ValidateAudioInfo(srcInfo); err != nil {
		log.Warn("source_rejected", "key", in.Request.SourceKey, "reason", err.Error(),
			"format", srcInfo.Format, "codec", srcInfo.AudioCodec, "duration", srcInfo.Duration)
		return Output{}, fmt.Errorf("source rejected: %w", err)
	}

	log.Info("audio_cut_start", "start_ms", in.Request.StartMs, "end_ms", in.Request.EndMs)
	if err := CutAudio(ctx, r.FFmpegBin, srcPath, cutPath, in.Request.StartMs, in.Request.EndMs); err != nil {
		return Output{}, fmt.Errorf("audio cut: %w", err)
	}
	audioDur, err := ProbeDuration(ctx, r.FFprobeBin, cutPath)
	if err != nil {
		return Output{}, fmt.Errorf("audio probe: %w", err)
	}

	// Parallel: backgrounds list+concat AND transcription.
	g, gctx := errgroup.WithContext(ctx)
	var bgPath string
	var transcriptResult transcript.Result

	g.Go(func() error {
		log.Info("backgrounds_start", "theme", in.Request.Theme)
		p, err := ListAndConcatBackgrounds(gctx, BackgroundsInput{
			S3:          r.S3,
			FFmpegBin:   r.FFmpegBin,
			Bucket:      r.Bucket,
			Prefix:      r.BackgroundsPrefix,
			Theme:       in.Request.Theme,
			VideoID:     in.VideoID,
			DurationSec: audioDur,
			TempDir:     filepath.Join(in.TempDir, "bg"),
		})
		if err != nil {
			return fmt.Errorf("backgrounds: %w", err)
		}
		bgPath = p
		return nil
	})
	g.Go(func() error {
		log.Info("transcribe_start", "lang", in.Request.Lang)
		res, err := r.Transcriber.Transcribe(gctx, cutPath, transcript.Options{Language: in.Request.Lang})
		if err != nil {
			return fmt.Errorf("transcribe: %w", err)
		}
		transcriptResult = res
		return nil
	})
	if err := g.Wait(); err != nil {
		return Output{}, err
	}

	// Align caller's punctuated text to the recogniser's timings.
	aligned := align.ForceAlign(in.Request.Text, transcriptResult.Words, audioDur)
	slides := align.WordsToSlides(aligned, 60) // maxCharsPerSlide
	if len(slides) == 0 {
		return Output{}, fmt.Errorf("force-align produced no slides")
	}

	log.Info("frames_start", "slides", len(slides))
	framesDir := filepath.Join(in.TempDir, "frames")
	var allFrames []reel.FrameSpec
	for i, slide := range slides {
		fs, err := r.Frames.GenerateWordFrames(slide, i, framesDir)
		if err != nil {
			return Output{}, fmt.Errorf("render slide %d: %w", i, err)
		}
		allFrames = append(allFrames, fs...)
	}

	// Title card on top of the first 0.5s (optional). The audio is NOT
	// shifted — the title overlay sits on top of the first 0.5s of
	// audio. Matches ReelGenerator.ts:143-159.
	if !in.Request.SkipIntro && strings.TrimSpace(in.Request.Title) != "" && r.TitleIconPath != "" {
		titleFramePath := filepath.Join(in.TempDir, "title_frame.png")
		if err := r.Frames.GenerateTitleFrame(in.Request.Title, titleFramePath); err == nil {
			// Drop frames the title fully covers; clip the first
			// surviving one to start at the title-overlay end.
			var survived []reel.FrameSpec
			for _, f := range allFrames {
				if f.StartTime+f.Duration > titleOverlayDur {
					survived = append(survived, f)
				}
			}
			if len(survived) > 0 {
				if survived[0].StartTime < titleOverlayDur {
					survived[0].StartTime = titleOverlayDur
				}
			}
			allFrames = append([]reel.FrameSpec{{
				Path:      titleFramePath,
				Duration:  titleOverlayDur,
				StartTime: 0,
			}}, survived...)
		}
	}

	// Composite. SkipLogo suppresses the trailing logo.mp4 append by
	// handing the composer an empty logo path.
	finalPath := filepath.Join(in.TempDir, "reel.mp4")
	logoPath := r.LogoPath
	if in.Request.SkipLogo {
		logoPath = ""
	}
	log.Info("composite_start", "frames", len(allFrames))
	if err := r.Composer.Compose(ctx, bgPath, allFrames, cutPath, audioDur, logoPath, finalPath, in.TempDir); err != nil {
		return Output{}, fmt.Errorf("compose: %w", err)
	}

	// Upload.
	outputKey := strings.TrimRight(r.OutputPrefix, "/") + "/" + in.VideoID + ".mp4"
	log.Info("upload_start", "key", outputKey)
	if err := r.uploadOutput(ctx, finalPath, outputKey); err != nil {
		return Output{}, fmt.Errorf("upload: %w", err)
	}

	url := r.buildOutputURL(outputKey)
	log.Info("render_done", "dur_ms", time.Since(start).Milliseconds(), "url", url)
	return Output{URL: url, OutputKey: outputKey}, nil
}

func (r *Renderer) downloadSource(ctx context.Context, key, dst string) error {
	resp, err := r.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = copyAll(f, resp.Body)
	return err
}

func (r *Renderer) uploadOutput(ctx context.Context, localPath, key string) error {
	if r.BunnyOut != nil {
		return r.BunnyOut.Put(ctx, key, localPath, "video/mp4")
	}
	body, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	_, err = r.S3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(r.Bucket),
		Key:          aws.String(key),
		Body:         bytesReader(body),
		ContentType:  aws.String("video/mp4"),
		CacheControl: aws.String("public, max-age=31536000, immutable"),
	})
	return err
}

func (r *Renderer) buildOutputURL(key string) string {
	if r.OutputPublicBase != "" {
		return strings.TrimRight(r.OutputPublicBase, "/") + "/" + key
	}
	return fmt.Sprintf("https://%s.s3.%s.amazonaws.com/%s", r.Bucket, r.Region, key)
}
