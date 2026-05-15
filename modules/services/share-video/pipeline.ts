import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { S3Client } from '@aws-sdk/client-s3';
import { ReelGenerator } from './src/ReelGenerator';
import { getTranscriber } from './src/utils/transcribers';
import { forceAlign, wordsToSlides } from './src/utils/forceAlign';
import { listAndConcatBackgrounds } from './src/utils/s3Backgrounds';
import { downloadToFile, uploadFile, buildPublicUrl } from './storage';
import { RenderRequest } from './eventAdapter';

const SLIDE_WIDTH = 1080;
const SLIDE_HEIGHT = 1920;
const MAX_CHARS_PER_SLIDE = 60;
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/bin/ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || guessFfprobe(FFMPEG_BIN);

function guessFfprobe(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath);
  const cand = path.join(dir, 'ffprobe');
  return fs.existsSync(cand) ? cand : 'ffprobe';
}

export interface RenderArgs {
  req: RenderRequest;
  videoId: string;
  bucket: string;
  backgroundsPrefix: string;
  outputPrefix: string;
  logoPath?: string;
  s3: S3Client;
  tempDir: string;
}

export interface RenderResult {
  videoId: string;
  url: string;
  outputKey: string;
}

/**
 * Cut audio → list+concat backgrounds → Whisper → align → render → upload.
 * Caller is responsible for wiping `tempDir` afterwards (handler does it in
 * a `finally` block).
 */
export async function renderReel(args: RenderArgs): Promise<RenderResult> {
  const { req, videoId, bucket, backgroundsPrefix, outputPrefix, logoPath, s3, tempDir } = args;
  const t0 = Date.now();
  fs.mkdirSync(tempDir, { recursive: true });

  // 1. Download source MP3.
  const srcMp3 = path.join(tempDir, 'source.mp3');
  await downloadToFile(s3, bucket, req.sourceKey, srcMp3);
  const t1 = Date.now();

  // 2. Cut to [start_ms, end_ms]. Probe first to fail fast on out-of-range.
  const sourceDurMs = ffprobeDurationMs(srcMp3);
  if (req.endMs > sourceDurMs) {
    const err = new Error(
      `end_ms beyond source duration (got ${req.endMs}, source is ${sourceDurMs} ms)`,
    ) as Error & { http?: number };
    err.http = 400;
    throw err;
  }
  const cutMp3 = path.join(tempDir, 'cut.mp3');
  cutAudio(srcMp3, cutMp3, req.startMs, req.endMs);
  const t2 = Date.now();

  const durationSec = (req.endMs - req.startMs) / 1000;

  // 3. Background list + concat (parallel with Whisper).
  const backgroundPromise = listAndConcatBackgrounds({
    bucket,
    prefix: backgroundsPrefix,
    theme: req.theme,
    videoId,
    durationSec,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    tempDir,
    s3,
  });

  // 4. Word-level transcription via the configured provider (whisper or speechkit).
  let whisper;
  try {
    const transcriber = await getTranscriber({ s3, bucket });
    whisper = await transcriber.transcribe(cutMp3, { language: req.lang });
  } catch (e: any) {
    console.error(JSON.stringify({ phase: 'transcribe-failed', provider: process.env.TRANSCRIBER || 'whisper', message: String(e?.message || e), name: e?.name }));
    const err = new Error(`transcription failed: ${e?.message || e}`) as Error & { http?: number };
    err.http = 502;
    throw err;
  }
  const t3 = Date.now();

  const backgroundVideoPath = await backgroundPromise;
  const t4 = Date.now();

  // 5. Force-align caller text → Whisper timings → slides.
  const aligned = forceAlign(req.text, whisper.words, durationSec);
  const slides = wordsToSlides(aligned, MAX_CHARS_PER_SLIDE);
  const t5 = Date.now();

  // 6. Render reel.
  const finalMp4 = path.join(tempDir, 'reel.mp4');
  await new ReelGenerator().generateReel({
    audioPath: cutMp3,
    outputPath: finalMp4,
    tempDir,
    slides,
    backgroundVideoPath,
    ...(logoPath && fs.existsSync(logoPath) ? { logoVideoPath: logoPath } : {}),
    slideWidth: SLIDE_WIDTH,
    slideHeight: SLIDE_HEIGHT,
    maxCharsPerSlide: MAX_CHARS_PER_SLIDE,
  });
  const t6 = Date.now();

  // 7. Upload.
  const outputKey = `${outputPrefix.replace(/\/$/, '')}/${videoId}.mp4`;
  await uploadFile(s3, bucket, outputKey, finalMp4, 'video/mp4', 'public, max-age=31536000, immutable');
  const t7 = Date.now();

  console.log(
    JSON.stringify({
      phase: 'render-complete',
      video_id: videoId,
      durations_ms: {
        download_src: t1 - t0,
        cut: t2 - t1,
        whisper: t3 - t2,
        bg_list_concat: t4 - t3,
        align: t5 - t4,
        render: t6 - t5,
        upload: t7 - t6,
        total: t7 - t0,
      },
      slides: slides.length,
      whisper_words: whisper.words.length,
    }),
  );

  return {
    videoId,
    url: buildPublicUrl(bucket, outputKey),
    outputKey,
  };
}

function cutAudio(src: string, dst: string, startMs: number, endMs: number): void {
  const startS = (startMs / 1000).toFixed(3);
  const durS = ((endMs - startMs) / 1000).toFixed(3);
  const r = spawnSync(
    FFMPEG_BIN,
    [
      '-nostdin',
      '-y',
      '-ss', startS,
      '-i', src,
      '-t', durS,
      '-c', 'copy',
      '-loglevel', 'error',
      dst,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg cut failed (exit ${r.status})`);
  }
}

function ffprobeDurationMs(audioPath: string): number {
  const r = spawnSync(
    FFPROBE_BIN,
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`ffprobe failed (exit ${r.status})`);
  }
  const seconds = parseFloat(String(r.stdout).trim());
  if (!Number.isFinite(seconds)) {
    throw new Error('ffprobe returned no duration');
  }
  return Math.round(seconds * 1000);
}
