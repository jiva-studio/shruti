import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { Slide, ReelGeneratorOptions, WordTiming } from '../types';
import { registerFonts } from './fontManager';

/**
 * Wraps text into multiple lines based on canvas width
 */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine + (currentLine.length > 0 ? ' ' : '') + word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Generates text overlay images for each slide
 * @param slides - Array of slides to generate
 * @param options - Generator options
 * @param useTransparentBackground - If true, creates transparent PNGs for overlay
 * @returns Array of paths to generated images
 */
export async function generateSlideImages(
  slides: Slide[],
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean = false
): Promise<string[]> {
  const tempDir = path.join(process.cwd(), 'temp_slides');

  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Register fonts once
  registerFonts();

  const imagePaths: string[] = [];

  console.log(`\nGenerating ${slides.length} slide images...`);

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    console.log(`\nSlide ${i + 1}/${slides.length}:`);
    console.log(`  Text: "${slide.text}"`);
    console.log(`  Duration: ${slide.duration.toFixed(2)}s`);

    const canvas = createCanvas(options.slideWidth, options.slideHeight);
    const ctx = canvas.getContext('2d');

    // Draw background
    if (useTransparentBackground) {
      // Transparent background for overlay on video
      // Add semi-transparent dark background for text readability
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
    } else {
      // Solid color background
      ctx.fillStyle = options.backgroundColor;
      ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
    }

    // Set text properties
    const fontString = `bold ${options.fontSize}px CustomFont, sans-serif`;
    ctx.font = fontString;
    ctx.fillStyle = options.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    console.log(`  Font: ${fontString}`);
    console.log(`  Text color: ${options.textColor}`);

    // Wrap text to fit canvas
    const maxTextWidth = options.slideWidth * 0.85;
    const lines = wrapText(ctx, slide.text, maxTextWidth);

    console.log(`  Wrapped into ${lines.length} lines:`);
    lines.forEach((line, idx) => console.log(`    ${idx + 1}. "${line}"`));

    // Calculate vertical positioning
    const lineHeight = options.fontSize * 1.2;
    const totalHeight = lines.length * lineHeight;
    const startY = options.slideHeight * 0.75 - totalHeight / 2;

    // Calculate background dimensions
    const padding = 40;
    const bgWidth = maxTextWidth + padding * 2;
    const bgHeight = totalHeight + padding * 1.5;
    const bgX = (options.slideWidth - bgWidth) / 2;
    const bgY = startY - padding * 0.75;
    const cornerRadius = 30;

    // Draw rounded rectangle background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.roundRect(bgX, bgY, bgWidth, bgHeight, cornerRadius);
    ctx.fill();

    // Draw text with outline for better visibility
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = options.textColor;

    lines.forEach((line, index) => {
      const y = startY + (index + 0.5) * lineHeight;
      // Outline
      ctx.strokeText(line, options.slideWidth / 2, y);
      // Fill
      ctx.fillText(line, options.slideWidth / 2, y);
    });

    // Save image
    const imagePath = path.join(tempDir, `slide_${i.toString().padStart(3, '0')}.png`);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(imagePath, buffer);
    imagePaths.push(imagePath);

    console.log(`  ✓ Saved: ${imagePath}`);
  }

  return imagePaths;
}

/**
 * Generates individual frames with word-level highlighting for animated text
 * @param slide - Slide with word timing information
 * @param options - Generator options
 * @param useTransparentBackground - If true, creates transparent PNGs for overlay
 * @param slideIndex - Index of the slide for naming
 * @returns Array of frame paths with their display durations
 */
export async function generateWordHighlightFrames(
  slide: Slide,
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  slideIndex: number
): Promise<Array<{ path: string; duration: number; startTime: number }>> {
  const tempDir = path.join(process.cwd(), 'temp_slides');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Register fonts once
  registerFonts();

  const frames: Array<{ path: string; duration: number; startTime: number }> = [];

  if (!slide.words || slide.words.length === 0) {
    // Fallback: generate single frame without word highlighting
    const framePath = await generateSingleFrame(
      slide.text,
      options,
      useTransparentBackground,
      slideIndex,
      -1
    );
    frames.push({
      path: framePath,
      duration: slide.duration,
      startTime: slide.startTime || 0
    });
    return frames;
  }

  // Generate a frame for each word being highlighted
  console.log(`  Generating ${slide.words.length} frames for word-level highlighting`);

  for (let wordIndex = 0; wordIndex < slide.words.length; wordIndex++) {
    const word = slide.words[wordIndex];
    const framePath = await generateSingleFrame(
      slide.text,
      options,
      useTransparentBackground,
      slideIndex,
      wordIndex,
      slide.words
    );

    const duration = word.end - word.start;
    frames.push({
      path: framePath,
      duration,
      startTime: word.start  // Use absolute timestamp from audio
    });
  }

  if (slide.words.length > 0) {
    console.log(`    Generated ${slide.words.length} frames for word-level highlighting`);
  }

  return frames;
}

/**
 * Generates a single frame with optional word highlighting
 */
async function generateSingleFrame(
  text: string,
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  slideIndex: number,
  highlightWordIndex: number,
  words?: WordTiming[]
): Promise<string> {
  const canvas = createCanvas(options.slideWidth, options.slideHeight);
  const ctx = canvas.getContext('2d');

  // Draw background
  if (useTransparentBackground) {
    // Leave canvas fully transparent - don't fill anything
    // The background video will show through
  } else {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
  }

  // Set text properties
  const fontString = `bold ${options.fontSize}px CustomFont, sans-serif`;
  ctx.font = fontString;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Wrap text to fit canvas
  const maxTextWidth = options.slideWidth * 0.85;
  const lines = wrapText(ctx, text, maxTextWidth);

  // Calculate vertical positioning
  const lineHeight = options.fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  const startY = options.slideHeight * 0.75 - totalHeight / 2;

  // Draw rounded rectangle background behind text only (always draw this)
  const padding = 40;
  const bgWidth = maxTextWidth + padding * 2;
  const bgHeight = totalHeight + padding * 1.5;
  const bgX = (options.slideWidth - bgWidth) / 2;
  const bgY = startY - padding * 0.75;
  const cornerRadius = 30;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.beginPath();
  ctx.roundRect(bgX, bgY, bgWidth, bgHeight, cornerRadius);
  ctx.fill();

  // If we have word-level highlighting, render word by word
  if (words && words.length > 0 && highlightWordIndex >= 0 && highlightWordIndex < words.length) {
    renderTextWithWordHighlight(
      ctx,
      lines,
      highlightWordIndex,
      options,
      startY,
      lineHeight
    );
  } else {
    // Render without highlighting
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = options.textColor;
    ctx.textAlign = 'center';

    lines.forEach((line, index) => {
      const y = startY + (index + 0.5) * lineHeight;
      ctx.strokeText(line, options.slideWidth / 2, y);
      ctx.fillText(line, options.slideWidth / 2, y);
    });
  }

  // Save image
  const tempDir = path.join(process.cwd(), 'temp_slides');
  const framePath = path.join(
    tempDir,
    `slide_${slideIndex.toString().padStart(3, '0')}_word_${highlightWordIndex.toString().padStart(3, '0')}.png`
  );
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(framePath, buffer);

  return framePath;
}

/**
 * Renders text with word-by-word highlighting
 */
function renderTextWithWordHighlight(
  ctx: SKRSContext2D,
  lines: string[],
  highlightWordIndex: number,
  options: ReelGeneratorOptions,
  startY: number,
  lineHeight: number
): void {
  let wordIndex = 0;
  const centerX = options.slideWidth / 2;

  // Set text alignment to left for word-by-word rendering
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineWords = line.split(' ');
    const y = startY + (lineIdx + 0.5) * lineHeight;

    // Measure total line width to center the entire line
    const totalLineWidth = ctx.measureText(line).width;
    let currentX = centerX - totalLineWidth / 2;

    for (let i = 0; i < lineWords.length; i++) {
      const word = lineWords[i];
      const isHighlighted = wordIndex === highlightWordIndex;

      // Set color for this word
      if (isHighlighted) {
        ctx.fillStyle = '#FFD700'; // Gold/yellow for highlighted word
        ctx.lineWidth = 8;
        ctx.strokeStyle = '#000000';
      } else {
        ctx.fillStyle = options.textColor;
        ctx.lineWidth = 8;
        ctx.strokeStyle = '#000000';
      }

      // Draw word with outline at current position
      ctx.strokeText(word, currentX, y);
      ctx.fillText(word, currentX, y);

      // Move to next word position
      const wordWidth = ctx.measureText(word).width;
      const spaceWidth = ctx.measureText(' ').width;
      currentX += wordWidth + spaceWidth;

      wordIndex++;
    }
  }
}

/**
 * Cleans up temporary files
 * @param paths - Array of file paths to delete
 */
export function cleanupTempFiles(paths: string[]): void {
  paths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  // Remove temp directory if empty
  const tempDir = path.join(process.cwd(), 'temp_slides');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    if (files.length === 0) {
      fs.rmdirSync(tempDir);
    }
  }
}
