import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { ReelConfig, ReelGeneratorOptions, Slide } from './types';
import { generateSlideImages, generateWordHighlightFrames, cleanupTempFiles } from './utils/videoGenerator';
import { transcribeAudioWithTimestamps, WordTimestamp } from './utils/transcription';
import { generateContinuousBackground } from './utils/videoBackgrounds';

/**
 * Splits long text into multiple slides based on character limit
 */
function splitTextIntoSlides(
  text: string,
  maxCharsPerSlide: number,
  totalDuration: number
): Slide[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const slides: Slide[] = [];
  let currentSlide = '';

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();

    if (currentSlide.length + trimmedSentence.length > maxCharsPerSlide && currentSlide.length > 0) {
      slides.push({ text: currentSlide.trim(), duration: 0 });
      currentSlide = trimmedSentence;
    } else {
      currentSlide += (currentSlide.length > 0 ? ' ' : '') + trimmedSentence;
    }
  }

  if (currentSlide.trim().length > 0) {
    slides.push({ text: currentSlide.trim(), duration: 0 });
  }

  const durationPerSlide = totalDuration / slides.length;
  slides.forEach(slide => {
    slide.duration = durationPerSlide;
  });

  return slides;
}

/**
 * Splits text into slides using word timestamps from transcription
 */
function splitTextIntoSlidesWithTimestamps(
  words: WordTimestamp[],
  maxCharsPerSlide: number
): Slide[] {
  if (!words || words.length === 0) {
    return [];
  }

  const slides: Slide[] = [];
  let currentSlide = '';
  let currentWords: WordTimestamp[] = [];

  for (const word of words) {
    const testSlide = currentSlide + (currentSlide.length > 0 ? ' ' : '') + word.word;

    // If adding this word exceeds the limit and we have some words already
    if (testSlide.length > maxCharsPerSlide && currentWords.length > 0) {
      // Create slide from current words
      const startTime = currentWords[0].start;
      const endTime = currentWords[currentWords.length - 1].end;

      slides.push({
        text: currentSlide.trim(),
        duration: endTime - startTime,
        startTime,
        endTime,
        words: currentWords.map(w => ({
          word: w.word,
          start: w.start,
          end: w.end,
        })),
      });

      // Start new slide with current word
      currentSlide = word.word;
      currentWords = [word];
    } else {
      // Add word to current slide
      currentSlide = testSlide;
      currentWords.push(word);
    }
  }

  // Add final slide if any words remain
  if (currentWords.length > 0) {
    const startTime = currentWords[0].start;
    const endTime = currentWords[currentWords.length - 1].end;

    slides.push({
      text: currentSlide.trim(),
      duration: endTime - startTime,
      startTime,
      endTime,
      words: currentWords.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
      })),
    });
  }

  return slides;
}

export class ReelGenerator {
  private options: ReelGeneratorOptions;

  constructor() {
    this.options = {
      maxCharsPerSlide: 60,
      slideWidth: 1080,
      slideHeight: 1920, // 9:16 aspect ratio for reels
      backgroundColor: '#000000',
      textColor: '#FFFFFF',
      fontSize: 80,
      fontFamily: 'Arial',
    };
  }

  /**
   * Gets the duration of an audio file
   * @param audioPath - Path to audio file
   * @returns Promise resolving to duration in seconds
   */
  private getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata.format.duration || 0);
        }
      });
    });
  }

  /**
   * Generates a video file list from frame data with individual durations
   * @param frameData - Array of frames with paths and durations
   * @returns Path to file list
   */
  private generateFileListWithFrames(
    frameData: Array<{ path: string; duration: number }>
  ): string {
    const fileListPath = path.join(process.cwd(), 'temp_slides', 'filelist.txt');
    const lines = frameData.map((frame, index) => {
      console.log(`  Frame ${index + 1}: ${path.basename(frame.path)} duration=${frame.duration.toFixed(3)}s`);
      return `file '${frame.path}'\nduration ${frame.duration.toFixed(6)}`;
    });

    // Add last frame again for proper ending
    if (frameData.length > 0) {
      lines.push(`file '${frameData[frameData.length - 1].path}'`);
    }

    const content = lines.join('\n');
    fs.writeFileSync(fileListPath, content);

    console.log(`\nFile list written to: ${fileListPath}`);
    console.log(`Total frames: ${frameData.length}`);
    console.log(`Total duration: ${frameData.reduce((sum, f) => sum + f.duration, 0).toFixed(2)}s`);

    return fileListPath;
  }

  /**
   * Generates a reel video from audio and text
   * @param config - Reel configuration
   * @returns Promise resolving when video is generated
   */
  async generateReel(config: ReelConfig): Promise<void> {
    // Merge user config with defaults
    const mergedOptions: ReelGeneratorOptions = {
      ...this.options,
      ...(config.maxCharsPerSlide && { maxCharsPerSlide: config.maxCharsPerSlide }),
      ...(config.slideWidth && { slideWidth: config.slideWidth }),
      ...(config.slideHeight && { slideHeight: config.slideHeight }),
      ...(config.backgroundColor && { backgroundColor: config.backgroundColor }),
      ...(config.textColor && { textColor: config.textColor }),
      ...(config.fontSize && { fontSize: config.fontSize }),
      ...(config.fontFamily && { fontFamily: config.fontFamily }),
    };

    try {
      // Validate required inputs
      if (!config.audioPath) {
        throw new Error('Audio path is required');
      }

      if (!config.outputPath) {
        throw new Error('Output path is required');
      }

      // Validate audio file exists
      if (!fs.existsSync(config.audioPath)) {
        throw new Error(`Audio file not found: ${config.audioPath}`);
      }

      // Validate background folder if provided
      if (config.backgroundVideosFolder && !fs.existsSync(config.backgroundVideosFolder)) {
        throw new Error(`Background videos folder not found: ${config.backgroundVideosFolder}`);
      }

      // Validate transcription requirements
      if (config.transcribe && !config.openaiApiKey && !process.env.OPENAI_API_KEY) {
        throw new Error('OpenAI API key is required for transcription. Provide openaiApiKey or set OPENAI_API_KEY environment variable.');
      }

      // Use original audio without silence removal
      const processedAudioPath = config.audioPath;

      // Get text - either from config or by transcription
      let textContent: string;
      let slides: Slide[];

      if (config.transcribe) {
        console.log('🎤 Transcribing audio with timestamps...');
        const transcriptionResult = await transcribeAudioWithTimestamps(processedAudioPath, config.openaiApiKey);
        textContent = transcriptionResult.text;
        console.log(`✓ Transcription: "${textContent.substring(0, 100)}${textContent.length > 100 ? '...' : ''}"`);

        // Use timestamp-based splitting if we have word timestamps
        if (transcriptionResult.words && transcriptionResult.words.length > 0) {
          console.log('Splitting text into slides using word timestamps...');
          slides = splitTextIntoSlidesWithTimestamps(
            transcriptionResult.words,
            mergedOptions.maxCharsPerSlide
          );
          console.log(`Created ${slides.length} slides with precise timing`);
        } else {
          // Fallback to duration-based splitting
          console.log('Getting audio duration...');
          const audioDuration = await this.getAudioDuration(processedAudioPath);
          console.log(`Audio duration: ${audioDuration.toFixed(2)} seconds`);

          console.log('Splitting text into slides...');
          slides = splitTextIntoSlides(
            textContent,
            mergedOptions.maxCharsPerSlide,
            audioDuration
          );
          console.log(`Created ${slides.length} slides`);
        }
      } else {
        if (!config.text) {
          throw new Error('Either provide text or set transcribe: true to auto-transcribe audio');
        }
        textContent = config.text;

        console.log('Getting audio duration...');
        const audioDuration = await this.getAudioDuration(processedAudioPath);
        console.log(`Audio duration: ${audioDuration.toFixed(2)} seconds`);

        console.log('Splitting text into slides...');
        slides = splitTextIntoSlides(
          textContent,
          mergedOptions.maxCharsPerSlide,
          audioDuration
        );
        console.log(`Created ${slides.length} slides`);
      }

      // Get audio duration for background video (reuse from above if already fetched)
      const audioDuration = config.transcribe && slides.length > 0 && slides[0].startTime !== undefined
        ? slides.reduce((max, s) => Math.max(max, (s.endTime || 0)), 0)
        : await this.getAudioDuration(processedAudioPath);
      console.log(`Audio duration: ${audioDuration.toFixed(2)} seconds`);

      // Generate continuous background video if folder provided
      let backgroundVideoPath: string | undefined;
      const useVideoBackgrounds = !!config.backgroundVideosFolder;

      if (useVideoBackgrounds) {
        const tempDir = path.join(process.cwd(), 'temp_slides');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Use audio duration for background (not slide durations which may be shorter)
        backgroundVideoPath = await generateContinuousBackground(
          config.backgroundVideosFolder!,
          audioDuration,
          mergedOptions.slideWidth,
          mergedOptions.slideHeight,
          tempDir
        );
      }

      // Check if we have valid word-level timings for highlighting
      const hasWordTimings = slides.some(slide =>
        slide.words &&
        slide.words.length > 0 &&
        slide.words.every(w => typeof w.start === 'number' && typeof w.end === 'number' && w.start >= 0 && w.end > w.start)
      );

      let allFramePaths: string[] = [];
      let frameData: Array<{ path: string; duration: number; startTime: number }> = [];

      if (hasWordTimings) {
        console.log('Generating text overlays with word-by-word highlighting...');

        for (let i = 0; i < slides.length; i++) {
          const slide = slides[i];
          const frames = await generateWordHighlightFrames(
            slide,
            mergedOptions,
            useVideoBackgrounds,
            i
          );

          frames.forEach(frame => {
            allFramePaths.push(frame.path);
            frameData.push(frame);
          });

          console.log(`  Slide ${i + 1}/${slides.length}: Generated ${frames.length} frames for word highlighting`);
        }
      } else {
        console.log('Generating text overlay images...');
        const textOverlayPaths = await generateSlideImages(
          slides,
          mergedOptions,
          useVideoBackgrounds
        );

        allFramePaths = textOverlayPaths;
        frameData = slides.map((slide, i) => ({
          path: textOverlayPaths[i],
          duration: slide.duration,
          startTime: slide.startTime || 0
        }));
      }

      // Check if we should append a logo video
      const logoVideoPath = this.getRandomLogoVideo();
      const tempVideoPath = logoVideoPath
        ? config.outputPath.replace(/\.(\w+)$/, '_temp.$1')
        : config.outputPath;

      if (logoVideoPath) {
        console.log(`📹 Found logo video: ${path.basename(logoVideoPath)}`);
      }

      if (useVideoBackgrounds && backgroundVideoPath) {
        // Overlay word-highlighted frames onto continuous background video
        console.log('Overlaying word-highlighted text onto continuous background video...');
        const overlayResult = await this.overlayTextOnContinuousBackground(
          backgroundVideoPath,
          frameData,
          processedAudioPath,
          tempVideoPath
        );

        console.log('Cleaning up temporary files...');
        const filesToCleanup = [
          ...allFramePaths,
          backgroundVideoPath,
          overlayResult.textVideoPath
        ].filter(Boolean);
        cleanupTempFiles(filesToCleanup);
      } else {
        // Use word highlighting frames without background video
        console.log('Creating file list for FFmpeg with word timings...');
        const fileListPath = this.generateFileListWithFrames(frameData);

        console.log('Generating video...');
        await this.createVideo(fileListPath, processedAudioPath, tempVideoPath);

        console.log('Cleaning up temporary files...');
        cleanupTempFiles([...allFramePaths, fileListPath]);
      }

      // Append logo video if found
      if (logoVideoPath) {
        await this.appendLogoVideo(tempVideoPath, logoVideoPath, config.outputPath);
      }

      console.log(`✅ Reel generated successfully: ${config.outputPath}`);
    } catch (error) {
      console.error('Error generating reel:', error);
      throw error;
    }
  }

  /**
   * Gets a random video file from the logos folder
   * @returns Path to random logo video or undefined if folder doesn't exist or is empty
   */
  private getRandomLogoVideo(): string | undefined {
    const logosFolder = path.join(process.cwd(), 'logos');

    if (!fs.existsSync(logosFolder)) {
      return undefined;
    }

    const files = fs.readdirSync(logosFolder);
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
    });

    if (videoFiles.length === 0) {
      return undefined;
    }

    const randomFile = videoFiles[Math.floor(Math.random() * videoFiles.length)];
    return path.join(logosFolder, randomFile);
  }

  /**
   * Appends logo video to the end of the main video
   * @param mainVideoPath - Path to the main video
   * @param logoVideoPath - Path to the logo video
   * @param outputPath - Final output path
   */
  private async appendLogoVideo(
    mainVideoPath: string,
    logoVideoPath: string,
    outputPath: string
  ): Promise<void> {
    console.log('  📹 Appending logo video to the end of the reel...');

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(mainVideoPath)
        .input(logoVideoPath)
        .complexFilter([
          '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]'
        ])
        .outputOptions([
          '-map', '[outv]',
          '-map', '[outa]',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
        ])
        .output(outputPath)
        .on('start', (cmd) => console.log(`  FFmpeg: ${cmd}`))
        .on('end', () => {
          console.log('  ✓ Logo video appended successfully');
          // Clean up temp main video
          if (fs.existsSync(mainVideoPath)) fs.unlinkSync(mainVideoPath);
          resolve();
        })
        .on('error', (err) => {
          console.error('  ✗ Error appending logo video:', err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Overlays word-highlighted text frames onto a continuous background video
   * First creates a video from text frames, then overlays it on background
   * @param backgroundVideoPath - Path to the background video
   * @param frameData - Array of frame data with paths, durations, and start times
   * @param audioPath - Path to the audio file
   * @param outputPath - Path where the final video will be saved
   * @returns Object containing paths to the output video and intermediate text video
   */
  private async overlayTextOnContinuousBackground(
    backgroundVideoPath: string,
    frameData: Array<{ path: string; duration: number; startTime: number }>,
    audioPath: string,
    outputPath: string
  ): Promise<{ videoPath: string; textVideoPath: string }> {
    console.log(`  Processing ${frameData.length} text frames for overlay`);

    const tempDir = path.join(process.cwd(), 'temp_slides');

    // Get audio duration to match text video length
    const audioDuration = await this.getAudioDuration(audioPath);
    console.log(`  Audio duration: ${audioDuration.toFixed(2)}s`);

    // Step 1: Create a concat file list for text frames
    console.log('  Step 1: Creating text overlay video from frames...');
    const textConcatPath = path.join(tempDir, 'text_concat.txt');
    const textVideoPath = path.join(tempDir, 'text_overlay.mp4');

    // Build concat file - extend durations to fill gaps between words
    const concatLines: string[] = [];

    console.log(`    Building timeline for ${frameData.length} frames`);

    // Handle initial silence - show first frame from 0 to first word
    const firstFrame = frameData[0];
    if (firstFrame.startTime > 0) {
      console.log(`    Initial silence: ${firstFrame.startTime.toFixed(3)}s - showing first frame`);
      concatLines.push(`file '${firstFrame.path}'`);
      concatLines.push(`duration ${firstFrame.startTime.toFixed(6)}`);
    }

    for (let i = 0; i < frameData.length; i++) {
      const frame = frameData[i];
      const nextFrame = frameData[i + 1];

      // Calculate the duration this frame should be displayed
      let displayDuration: number;

      if (nextFrame) {
        // Extend this frame to cover the gap until the next frame starts
        const frameEnd = frame.startTime + frame.duration;
        const gapToNext = nextFrame.startTime - frameEnd;
        displayDuration = frame.duration + gapToNext;
      } else {
        // Last frame - extend to the end of audio
        displayDuration = audioDuration - frame.startTime;
      }

      concatLines.push(`file '${frame.path}'`);
      concatLines.push(`duration ${displayDuration.toFixed(6)}`);

      if (i < 3) {
        console.log(`    Frame ${i}: ${path.basename(frame.path)} @ ${frame.startTime.toFixed(3)}s for ${displayDuration.toFixed(3)}s (original: ${frame.duration.toFixed(3)}s)`);
      }
    }

    // Add last frame again for concat demuxer
    if (frameData.length > 0) {
      concatLines.push(`file '${frameData[frameData.length - 1].path}'`);
    }

    const totalFrameDuration = concatLines
      .filter(line => line.startsWith('duration'))
      .reduce((sum, line) => sum + parseFloat(line.split(' ')[1]), 0);
    console.log(`    Total video duration: ${totalFrameDuration.toFixed(2)}s (audio: ${audioDuration.toFixed(2)}s)`);

    fs.writeFileSync(textConcatPath, concatLines.join('\n'));

    // Create video from text frames with precise timing
    // Use QuickTime format which properly supports alpha channel
    const parsedPath = path.parse(textVideoPath);
    const textVideoPathMov = path.join(parsedPath.dir, `${parsedPath.name}.mov`);

    await new Promise<void>((resolve, reject) => {
      const ffmpegCmd = ffmpeg()
        .input(textConcatPath)
        .inputOptions([
          '-f', 'concat',
          '-safe', '0',
        ])
        .outputOptions([
          '-c:v', 'qtrle',  // QuickTime Animation codec - lossless with alpha
          '-vsync', 'vfr', // Variable frame rate to respect duration timestamps
        ])
        .output(textVideoPathMov)
        .on('start', (cmd) => console.log(`    Creating text video: ${cmd}`))
        .on('stderr', (line) => {
          // Log stderr to see what's happening with pixel format
          if (line.includes('pix_fmt') || line.includes('alpha')) {
            console.log(`    FFmpeg: ${line}`);
          }
        })
        .on('end', () => {
          console.log('    ✓ Text video created');
          resolve();
        })
        .on('error', (err) => {
          console.error('    ✗ Error creating text video:', err);
          reject(err);
        });

      ffmpegCmd.run();
    });

    console.log('  Step 2: Overlaying text video onto background...');

    // Step 2: Overlay the text video on the background
    return new Promise((resolve, reject) => {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      ffmpeg(backgroundVideoPath)
        .input(textVideoPathMov)
        .input(audioPath)
        .complexFilter([
          // Ensure both videos start at time 0 and overlay them
          '[0:v]setpts=PTS-STARTPTS[bg]',
          '[1:v]setpts=PTS-STARTPTS[txt]',
          '[bg][txt]overlay=0:0:shortest=0:repeatlast=1[outv]'
        ])
        .outputOptions([
          '-map', '[outv]', // Use filtered video output
          '-map', '2:a', // Use audio from third input
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-shortest',
        ])
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
          console.log('  ✓ Video generation completed');
          resolve({ videoPath: outputPath, textVideoPath: textVideoPathMov });
        })
        .on('error', (err) => {
          console.error('  ✗ FFmpeg error:', err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Creates the final video using FFmpeg
   * @param fileListPath - Path to file list
   * @param audioPath - Path to audio file
   * @param outputPath - Output video path
   * @returns Promise resolving when video is created
   */
  private createVideo(
    fileListPath: string,
    audioPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      ffmpeg()
        .input(fileListPath)
        .inputOptions([
          '-f concat',
          '-safe 0',
          '-vsync vfr', // Variable frame rate to respect duration timestamps
        ])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-shortest',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Progress: ${progress.percent.toFixed(2)}%`);
          }
        })
        .on('end', () => {
          console.log('Video processing completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .run();
    });
  }
}
