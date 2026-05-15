import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { ReelConfig, ReelGeneratorOptions } from './types';
import {
  generateSlideImages,
  generateWordHighlightFrames,
} from './utils/videoGenerator';
import { getVideoDuration } from './utils/videoBackgrounds';

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
  slideWidth: 1080,
  slideHeight: 1920,
  backgroundColor: '#000000',
  textColor: '#FFFFFF',
  fontSize: 80,
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
      for (let i = 0; i < config.slides.length; i++) {
        const frames = await generateWordHighlightFrames(
          config.slides[i],
          opts,
          true, // transparent — overlay on top of background
          i,
          config.tempDir,
        );
        frameData.push(...frames);
      }
    } else {
      const paths = await generateSlideImages(config.slides, opts, true, config.tempDir);
      frameData = config.slides.map((slide, i) => ({
        path: paths[i],
        duration: slide.duration,
        startTime: slide.startTime || 0,
      }));
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
              '-preset', 'fast',
              '-crf', '23',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac',
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

  private appendLogo(
    mainVideoPath: string,
    logoVideoPath: string,
    outputPath: string,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    return new Promise((resolve, reject) => {
      logPhase('logo-append-start');
      const startedAt = Date.now();
      const cmd = ffmpeg()
        .input(mainVideoPath)
        .input(logoVideoPath)
        .complexFilter(['[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]'])
        .outputOptions([
          '-map', '[outv]',
          '-map', '[outa]',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
        ])
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
