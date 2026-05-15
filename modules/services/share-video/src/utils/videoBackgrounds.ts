import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';

/**
 * Gets random video files from a folder
 * @param folderPath - Path to folder containing video files
 * @param count - Number of random videos to select
 * @returns Array of paths to randomly selected video files
 * @throws Error if folder doesn't exist or contains no video files
 */
export function getRandomVideoFiles(folderPath: string, count: number): string[] {
  if (!fs.existsSync(folderPath)) {
    throw new Error(`Background videos folder not found: ${folderPath}`);
  }

  const files = fs.readdirSync(folderPath);
  const videoFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
  });

  if (videoFiles.length === 0) {
    throw new Error(`No video files found in ${folderPath}`);
  }

  // Randomly select videos (with replacement if needed)
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * videoFiles.length);
    selected.push(path.join(folderPath, videoFiles[randomIndex]));
  }

  return selected;
}

/**
 * Gets duration of a video file in seconds
 * @param videoPath - Path to the video file
 * @returns Promise resolving to video duration in seconds
 */
export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}

/**
 * Extracts and crops a video clip from source video
 * Crops from center if video is larger than target dimensions
 * @param videoPath - Path to source video
 * @param outputPath - Path where extracted clip will be saved
 * @param targetWidth - Target width in pixels
 * @param targetHeight - Target height in pixels
 * @param startTime - Start time in seconds
 * @param duration - Duration of clip in seconds
 * @returns Promise that resolves when clip is extracted
 */
export function extractVideoClip(
  videoPath: string,
  outputPath: string,
  targetWidth: number,
  targetHeight: number,
  startTime: number,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`    Extracting clip from: ${path.basename(videoPath)}`);
    console.log(`      Start: ${startTime.toFixed(1)}s, Duration: ${duration.toFixed(1)}s`);

    ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(duration)
      .outputOptions([
        // Scale and crop from center
        `-vf scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`,
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-an', // No audio for background clips
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Generates a single continuous background video for the entire reel
 * @param videosFolder - Path to folder containing background videos
 * @param totalDuration - Total duration needed in seconds
 * @param targetWidth - Target width in pixels
 * @param targetHeight - Target height in pixels
 * @param tempDir - Temporary directory for output
 * @returns Promise resolving to path of generated background video
 */
export async function generateContinuousBackground(
  videosFolder: string,
  totalDuration: number,
  targetWidth: number,
  targetHeight: number,
  tempDir: string
): Promise<string> {
  console.log(`\nGenerating continuous background video from: ${videosFolder}`);
  console.log(`  Target duration: ${totalDuration.toFixed(2)}s`);

  // Get a random video file
  const videoFiles = getRandomVideoFiles(videosFolder, 1);
  const videoPath = videoFiles[0];
  const outputPath = path.join(tempDir, `bg_video_continuous.mp4`);

  console.log(`  Selected video: ${path.basename(videoPath)}`);

  try {
    // Get video duration
    const videoDuration = await getVideoDuration(videoPath);
    console.log(`  Video duration: ${videoDuration.toFixed(2)}s`);

    // Calculate start time - ensure we have enough video
    const maxStartTime = Math.max(0, videoDuration - totalDuration);
    const randomStartTime = Math.random() * maxStartTime;

    console.log(`  Extracting from ${randomStartTime.toFixed(2)}s for ${totalDuration.toFixed(2)}s`);

    // Extract and crop video clip
    await extractVideoClip(
      videoPath,
      outputPath,
      targetWidth,
      targetHeight,
      randomStartTime,
      totalDuration
    );

    console.log(`  ✓ Generated continuous background video`);
    return outputPath;
  } catch (error) {
    console.error(`  ✗ Error generating background:`, error);
    throw error;
  }
}

/**
 * Generates background video clips from video files for each slide
 * @param videosFolder - Path to folder containing background videos
 * @param slideCount - Number of slides
 * @param slideDurations - Array of durations for each slide
 * @param targetWidth - Target width in pixels
 * @param targetHeight - Target height in pixels
 * @param tempDir - Temporary directory for output
 * @returns Promise resolving to array of paths to generated background clips
 */
export async function generateVideoBackgrounds(
  videosFolder: string,
  slideCount: number,
  slideDurations: number[],
  targetWidth: number,
  targetHeight: number,
  tempDir: string
): Promise<string[]> {
  console.log(`\nGenerating video background clips from: ${videosFolder}`);

  // Get random video files
  const videoFiles = getRandomVideoFiles(videosFolder, slideCount);
  console.log(`Selected ${videoFiles.length} video files for backgrounds`);

  const backgroundPaths: string[] = [];

  for (let i = 0; i < slideCount; i++) {
    const videoPath = videoFiles[i];
    const outputPath = path.join(tempDir, `bg_video_${i.toString().padStart(3, '0')}.mp4`);
    const clipDuration = slideDurations[i];

    try {
      // Get video duration to select random start time
      const videoDuration = await getVideoDuration(videoPath);
      const maxStartTime = Math.max(0, videoDuration - clipDuration);
      const randomStartTime = Math.random() * maxStartTime;

      // Extract video clip (cropped from center)
      await extractVideoClip(
        videoPath,
        outputPath,
        targetWidth,
        targetHeight,
        randomStartTime,
        clipDuration
      );

      backgroundPaths.push(outputPath);
      console.log(`    ✓ Generated background clip ${i + 1}/${slideCount}`);
    } catch (error) {
      console.error(`    ✗ Error with video ${path.basename(videoPath)}:`, error);
      throw error;
    }
  }

  return backgroundPaths;
}
