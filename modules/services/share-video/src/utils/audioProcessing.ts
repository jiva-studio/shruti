import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';

/**
 * Removes silence from audio file using FFmpeg's silenceremove filter
 * @param inputPath - Path to input audio file
 * @param outputPath - Path to save processed audio (optional, creates temp file if not provided)
 * @param silenceThreshold - Silence threshold in dB (default: -30dB)
 * @param silenceDuration - Minimum silence duration to remove in seconds (default: 0.5s)
 * @returns Promise resolving to path of processed audio file
 */
export async function removeSilence(
  inputPath: string,
  outputPath?: string,
  silenceThreshold: number = -30,
  silenceDuration: number = 0.5
): Promise<string> {
  // Verify input file exists
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Audio file not found: ${inputPath}`);
  }

  // Create output path if not provided
  if (!outputPath) {
    const tempDir = path.join(process.cwd(), 'temp_audio');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const basename = path.basename(inputPath, path.extname(inputPath));
    outputPath = path.join(tempDir, `${basename}_no_silence.mp3`);
  }

  console.log('Removing silence from audio...');
  console.log(`  Input: ${inputPath}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Threshold: ${silenceThreshold}dB, Duration: ${silenceDuration}s`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([
        // Remove silence at the beginning
        `silenceremove=start_periods=1:start_silence=${silenceDuration}:start_threshold=${silenceThreshold}dB`,
        // Remove silence in the middle (detect and remove)
        `silenceremove=stop_periods=-1:stop_silence=${silenceDuration}:stop_threshold=${silenceThreshold}dB`,
      ])
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('  FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`  Progress: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        console.log('✓ Silence removal completed');
        resolve(outputPath!);
      })
      .on('error', (err) => {
        console.error('Silence removal error:', err);
        reject(new Error(`Failed to remove silence: ${err.message}`));
      })
      .run();
  });
}

/**
 * Cleans up temporary audio files
 * @param filePaths - Array of file paths to delete
 */
export function cleanupAudioFiles(filePaths: string[]): void {
  filePaths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted: ${filePath}`);
    }
  });

  // Remove temp audio directory if empty
  const tempDir = path.join(process.cwd(), 'temp_audio');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    if (files.length === 0) {
      fs.rmdirSync(tempDir);
      console.log(`Removed empty directory: ${tempDir}`);
    }
  }
}
