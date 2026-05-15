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
 * 5-second pack clips.
 *
 * Pack clips are pre-encoded to the exact target format at upload time
 * (h264/yuv420p/30fps at the reel's W×H — see scripts/upload-backgrounds.sh),
 * so the concat demuxer + `-c copy` just muxes streams together without a
 * second libx264 pass. Measured on Lambda: re-encode form was ~70 s for a
 * 33 s output, copy-mux form is ~3 s. The `-t` flag cuts at the previous
 * keyframe, which can leave the output up to ~1 s short — fine for a
 * background overlay where there is no sync constraint.
 *
 * If a future theme is uploaded with a different codec/profile/fps/pix_fmt
 * the concat demuxer will refuse the mux and we'd have to add a probe-and-
 * fallback-to-re-encode path. Audio is dropped (`-an`); the reel's audio
 * comes from the cut MP3, not the background pack. The W×H args are kept
 * in the signature so callers don't drift, but they are not used here —
 * the upload-time normalisation owns geometry.
 */
export function concatClips(
  clipPaths: string[],
  targetDurationSec: number,
  _width: number,
  _height: number,
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
        '-c', 'copy',
        '-an',
      ])
      .output(outPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}
