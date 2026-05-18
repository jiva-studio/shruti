import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { ReelConfig, ReelGeneratorOptions } from './types';
import {
  generateSlideImages,
  generateTitleFrame,
  generateWordHighlightFrames,
} from './utils/videoGenerator';
import { getVideoDuration } from './utils/videoBackgrounds';

// How long the cream title-card overlay covers the reel at the start when
// `config.title` is set. Audio is NOT shifted — the title sits on top of
// the first TITLE_DURATION_S seconds of audio.
const TITLE_DURATION_S = 0.5;

if (process.env.FFMPEG_BIN) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_BIN);
}
if (process.env.FFPROBE_BIN) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_BIN);
}

// One-line JSON event log; flushed immediately so CloudWatch / YC Logging see
// ffmpeg pass boundaries and per-pass progress while the worker is still running.
function logPhase(phase: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ phase, t_ms: Date.now(), ...fields }));
}

// Throttled fluent-ffmpeg progress logger: emits at most one event every 5 s
// (or on the final ~100% tick). Avoids spamming CloudWatch with one line/sec
// while still showing forward motion during long encodes.
function attachProgressLogger(cmd: any, label: string): void {
  let lastEmit = 0;
  cmd.on('progress', (p: { percent?: number; timemark?: string; currentFps?: number }) => {
    const now = Date.now();
    if (now - lastEmit < 5000 && (p.percent == null || p.percent < 99)) return;
    lastEmit = now;
    logPhase(`${label}-progress`, {
      percent: p.percent != null ? Math.round(p.percent * 10) / 10 : null,
      timemark: p.timemark,
      fps: p.currentFps,
    });
  });
}

const DEFAULTS: ReelGeneratorOptions = {
  slideWidth: 720,
  slideHeight: 1280,
  backgroundColor: '#000000',
  textColor: '#FFFFFF',
  // Scaled from 80 at the previous 1080p target by 720/1080 = 2/3 so the
  // text occupies the same relative slice of the frame.
  fontSize: 53,
  fontFamily: 'NotoSans',
  maxCharsPerSlide: 60,
};

/**
 * Renders a reel from preassembled inputs:
 *   - cut audio (caller already cut it from the source)
 *   - prebuilt background MP4 (caller already concatenated/scaled it)
 *   - slides with word-level timings (caller already aligned text↔Whisper)
 *   - optional logo MP4 to append at the end
 *
 * All temporary files go under `config.tempDir` (caller is responsible for
 * cleaning it up afterwards). The handler runs cleanup in its `finally`.
 */
export class ReelGenerator {
  async generateReel(config: ReelConfig): Promise<void> {
    const opts: ReelGeneratorOptions = {
      ...DEFAULTS,
      ...(config.slideWidth && { slideWidth: config.slideWidth }),
      ...(config.slideHeight && { slideHeight: config.slideHeight }),
      ...(config.backgroundColor && { backgroundColor: config.backgroundColor }),
      ...(config.textColor && { textColor: config.textColor }),
      ...(config.fontSize && { fontSize: config.fontSize }),
      ...(config.fontFamily && { fontFamily: config.fontFamily }),
      ...(config.maxCharsPerSlide && { maxCharsPerSlide: config.maxCharsPerSlide }),
    };

    if (!config.audioPath || !fs.existsSync(config.audioPath)) {
      throw new Error(`audio file not found: ${config.audioPath}`);
    }
    if (!config.backgroundVideoPath || !fs.existsSync(config.backgroundVideoPath)) {
      throw new Error(`background video not found: ${config.backgroundVideoPath}`);
    }
    if (!config.tempDir) {
      throw new Error('tempDir is required');
    }
    if (!config.slides || config.slides.length === 0) {
      throw new Error('slides[] is required');
    }
    fs.mkdirSync(config.tempDir, { recursive: true });

    const audioDuration = await getVideoDuration(config.audioPath);

    // Generate per-word frames if timing data is good, else single-frame slides.
    const hasWordTimings = config.slides.some(
      (s) =>
        s.words &&
        s.words.length > 0 &&
        s.words.every(
          (w) =>
            typeof w.start === 'number' &&
            typeof w.end === 'number' &&
            w.start >= 0 &&
            w.end > w.start,
        ),
    );

    let frameData: Array<{ path: string; duration: number; startTime: number }> = [];

    if (hasWordTimings) {
      // Slides are independent; render each slide's frames in parallel.
      // generateWordHighlightFrames itself parallelises across words within
      // a slide, so the full N-frame batch lights up every available vCPU.
      const perSlide = await Promise.all(
        config.slides.map((slide, i) =>
          generateWordHighlightFrames(
            slide,
            opts,
            true,
            i,
            config.tempDir,
          ),
        ),
      );
      frameData = perSlide.flat();
    } else {
      const paths = await generateSlideImages(config.slides, opts, true, config.tempDir);
      frameData = config.slides.map((slide, i) => ({
        path: paths[i],
        duration: slide.duration,
        startTime: slide.startTime || 0,
      }));
    }

    // Title-card overlay (optional). Render an opaque cream frame and
    // prepend it to the text-overlay frame list so it covers the first
    // TITLE_DURATION_S seconds. Subsequent frames are filtered/clipped to
    // resume right when the title ends, keeping word-highlight alignment.
    if (config.title && config.titleIconPath && fs.existsSync(config.titleIconPath)) {
      const titleFramePath = path.join(config.tempDir, 'title_frame.png');
      await generateTitleFrame(config.title, config.titleIconPath, opts, titleFramePath);
      const surviving = frameData.filter(
        (f) => f.startTime + f.duration > TITLE_DURATION_S,
      );
      if (surviving.length > 0) {
        surviving[0] = {
          ...surviving[0],
          startTime: Math.max(surviving[0].startTime, TITLE_DURATION_S),
        };
      }
      frameData = [
        { path: titleFramePath, duration: TITLE_DURATION_S, startTime: 0 },
        ...surviving,
      ];
    }

    // Step 1: composite text frames onto a transparent QuickTime track,
    // then overlay onto background video and mix in audio.
    const reelBeforeLogo =
      config.logoVideoPath
        ? path.join(config.tempDir, 'reel_no_logo.mp4')
        : config.outputPath;

    await this.overlayTextOnBackground(
      config.backgroundVideoPath,
      frameData,
      config.audioPath,
      reelBeforeLogo,
      audioDuration,
      config.tempDir,
    );

    // Step 2: optional logo append.
    if (config.logoVideoPath && fs.existsSync(config.logoVideoPath)) {
      await this.appendLogo(reelBeforeLogo, config.logoVideoPath, config.outputPath);
      // reelBeforeLogo is inside config.tempDir; handler-level cleanup wipes it.
    }
  }

  private overlayTextOnBackground(
    backgroundVideoPath: string,
    frameData: Array<{ path: string; duration: number; startTime: number }>,
    audioPath: string,
    outputPath: string,
    audioDuration: number,
    tempDir: string,
  ): Promise<void> {
    // Build a concat list that holds each frame for [startTime, nextStartTime).
    const concatLines: string[] = [];
    if (frameData.length > 0) {
      const first = frameData[0];
      if (first.startTime > 0) {
        concatLines.push(`file '${first.path}'`);
        concatLines.push(`duration ${first.startTime.toFixed(6)}`);
      }
      for (let i = 0; i < frameData.length; i++) {
        const cur = frameData[i];
        const next = frameData[i + 1];
        const display = next
          ? cur.duration + (next.startTime - (cur.startTime + cur.duration))
          : audioDuration - cur.startTime;
        concatLines.push(`file '${cur.path}'`);
        concatLines.push(`duration ${Math.max(0.001, display).toFixed(6)}`);
      }
      // Repeat the last frame so the concat demuxer accepts the last duration.
      concatLines.push(`file '${frameData[frameData.length - 1].path}'`);
    }

    const textConcatPath = path.join(tempDir, 'text_concat.txt');
    const textVideoPath = path.join(tempDir, 'text_overlay.mov');
    fs.writeFileSync(textConcatPath, concatLines.join('\n'));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
      logPhase('text-track-start', { frames: frameData.length });
      const textTrackStartedAt = Date.now();
      const textCmd = ffmpeg()
        .input(textConcatPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'qtrle', '-vsync', 'vfr'])
        .output(textVideoPath);
      attachProgressLogger(textCmd, 'text-track');
      textCmd
        .on('end', () => {
          logPhase('text-track-done', { ms: Date.now() - textTrackStartedAt });
          logPhase('composite-start');
          const compositeStartedAt = Date.now();
          const compCmd = ffmpeg(backgroundVideoPath)
            .input(textVideoPath)
            .input(audioPath)
            .complexFilter([
              '[0:v]setpts=PTS-STARTPTS[bg]',
              '[1:v]setpts=PTS-STARTPTS[txt]',
              '[bg][txt]overlay=0:0:shortest=0:repeatlast=1[outv]',
            ])
            .outputOptions([
              '-map', '[outv]',
              '-map', '2:a',
              '-c:v', 'libx264',
              // veryfast: ~1.5x faster than `fast`, ~10% larger file at the same
              // CRF. Social platforms re-transcode anyway; quality hit is
              // invisible after their pipeline.
              '-preset', 'veryfast',
              // zerolatency: drops B-frames and lookahead; another ~15% encode
              // speedup. Slightly worse compression but acceptable for our use.
              '-tune', 'zerolatency',
              '-crf', '23',
              '-pix_fmt', 'yuv420p',
              // Force CFR @ 30 fps so the output matches the logo container.
              // Without this, libx264 defaults to 25 fps (PAL fallback when no
              // input framerate is asserted), which (a) was an unintended drop
              // from the 30 fps bg clips, and (b) made the logo-append concat
              // demuxer reject `-c copy` due to framerate mismatch.
              '-r', '30',
              '-c:a', 'aac',
              // Lock audio params to match logo.mp4 so the post-composite logo
              // append can stream-copy instead of re-encode.
              '-ar', '44100',
              '-ac', '2',
              '-shortest',
            ])
            .output(outputPath);
          attachProgressLogger(compCmd, 'composite');
          compCmd
            .on('end', () => {
              logPhase('composite-done', { ms: Date.now() - compositeStartedAt });
              resolve();
            })
            .on('error', reject)
            .run();
        })
        .on('error', reject)
        .run();
    });
  }

  /**
   * Append the static logo MP4 to the end of the composited reel.
   *
   * Both files share codec params (h264/High/yuv420p/30fps/1080x1920, AAC
   * LC/44.1k/stereo) — the composite step pins them explicitly so this
   * holds. That means the concat *demuxer* with `-c copy` can mux the two
   * streams together without re-encoding. Previous form used the concat
   * *filter* + libx264 re-encode, which on a 67 s reel costs ~139 s on the
   * Lambda 3008 MB tier — for what is essentially a 3 s append. Now it
   * costs ~tail-of-disk-I/O.
   *
   * If a future change drops codec parity (e.g. logo regenerated at a
   * different fps), the concat demuxer will refuse the mux with a clear
   * "non-monotonous DTS" / "Could not find codec parameters" error in the
   * worker logs and we'd add a probe-and-fallback path.
   */
  private appendLogo(
    mainVideoPath: string,
    logoVideoPath: string,
    outputPath: string,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const listPath = path.join(path.dirname(outputPath), 'logo_concat.txt');
    const lines = [mainVideoPath, logoVideoPath]
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, lines);

    return new Promise((resolve, reject) => {
      logPhase('logo-append-start');
      const startedAt = Date.now();
      const cmd = ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
        .output(outputPath);
      attachProgressLogger(cmd, 'logo-append');
      cmd
        .on('end', () => {
          logPhase('logo-append-done', { ms: Date.now() - startedAt });
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }
}
