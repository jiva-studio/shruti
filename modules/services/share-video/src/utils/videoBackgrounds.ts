import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';

if (process.env.FFMPEG_BIN) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_BIN);
}
if (process.env.FFPROBE_BIN) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_BIN);
}

export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 0);
    });
  });
}

/**
 * Concatenate several pre-normalised clips into a single MP4 of (at most)
 * `targetDurationSec` seconds. Used by s3Backgrounds after downloading
 * 5-second pack clips. Re-encodes (we can't `-c copy` since clips may have
 * been touched by ffmpeg but we want a clean monotonic output), scales+crops
 * to the requested aspect, drops audio (the reel's audio comes from the cut
 * MP3, not the background pack).
 *
 * Pack clips are expected to share codec/profile/fps/pix_fmt — the
 * normalisation step at upload time (scripts/upload-backgrounds.sh) handles
 * that. If they differ, the concat demuxer will refuse and we'd have to
 * switch to the slower concat-filter form.
 */
export function concatClips(
  clipPaths: string[],
  targetDurationSec: number,
  width: number,
  height: number,
  outPath: string,
  tempDir: string,
): Promise<void> {
  if (clipPaths.length === 0) {
    return Promise.reject(new Error('concatClips: no clips supplied'));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const listPath = path.join(tempDir, 'bg_list.txt');
  const lines = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-t', targetDurationSec.toFixed(3),
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-an',
      ])
      .output(outPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}
