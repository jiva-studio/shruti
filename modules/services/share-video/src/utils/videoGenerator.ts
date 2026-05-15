import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { Slide, ReelGeneratorOptions, WordTiming } from '../types';
import { registerFonts, FONT_FAMILY } from './fontManager';

function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
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

export async function generateSlideImages(
  slides: Slide[],
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  tempDir: string,
): Promise<string[]> {
  fs.mkdirSync(tempDir, { recursive: true });
  registerFonts();

  const imagePaths: string[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const canvas = createCanvas(options.slideWidth, options.slideHeight);
    const ctx = canvas.getContext('2d');

    if (useTransparentBackground) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
    } else {
      ctx.fillStyle = options.backgroundColor;
      ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
    }

    ctx.font = `bold ${options.fontSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = options.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxTextWidth = options.slideWidth * 0.85;
    const lines = wrapText(ctx, slide.text, maxTextWidth);

    const lineHeight = options.fontSize * 1.2;
    const totalHeight = lines.length * lineHeight;
    const startY = options.slideHeight * 0.75 - totalHeight / 2;

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

    ctx.lineWidth = 8;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = options.textColor;

    lines.forEach((line, index) => {
      const y = startY + (index + 0.5) * lineHeight;
      ctx.strokeText(line, options.slideWidth / 2, y);
      ctx.fillText(line, options.slideWidth / 2, y);
    });

    const imagePath = path.join(
      tempDir,
      `slide_${i.toString().padStart(3, '0')}.png`,
    );
    fs.writeFileSync(imagePath, canvas.toBuffer('image/png'));
    imagePaths.push(imagePath);
  }

  return imagePaths;
}

export async function generateWordHighlightFrames(
  slide: Slide,
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  slideIndex: number,
  tempDir: string,
): Promise<Array<{ path: string; duration: number; startTime: number }>> {
  fs.mkdirSync(tempDir, { recursive: true });
  registerFonts();

  const frames: Array<{ path: string; duration: number; startTime: number }> = [];

  if (!slide.words || slide.words.length === 0) {
    const framePath = await generateSingleFrame(
      slide.text,
      options,
      useTransparentBackground,
      slideIndex,
      -1,
      tempDir,
    );
    frames.push({
      path: framePath,
      duration: slide.duration,
      startTime: slide.startTime || 0,
    });
    return frames;
  }

  for (let wordIndex = 0; wordIndex < slide.words.length; wordIndex++) {
    const word = slide.words[wordIndex];
    const framePath = await generateSingleFrame(
      slide.text,
      options,
      useTransparentBackground,
      slideIndex,
      wordIndex,
      tempDir,
      slide.words,
    );
    frames.push({
      path: framePath,
      duration: word.end - word.start,
      startTime: word.start,
    });
  }

  return frames;
}

async function generateSingleFrame(
  text: string,
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  slideIndex: number,
  highlightWordIndex: number,
  tempDir: string,
  words?: WordTiming[],
): Promise<string> {
  const canvas = createCanvas(options.slideWidth, options.slideHeight);
  const ctx = canvas.getContext('2d');

  if (!useTransparentBackground) {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);
  }

  ctx.font = `bold ${options.fontSize}px ${FONT_FAMILY}, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxTextWidth = options.slideWidth * 0.85;
  const lines = wrapText(ctx, text, maxTextWidth);

  const lineHeight = options.fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  const startY = options.slideHeight * 0.75 - totalHeight / 2;

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

  if (words && words.length > 0 && highlightWordIndex >= 0 && highlightWordIndex < words.length) {
    renderTextWithWordHighlight(ctx, lines, highlightWordIndex, options, startY, lineHeight);
  } else {
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

  const framePath = path.join(
    tempDir,
    `slide_${slideIndex.toString().padStart(3, '0')}_word_${highlightWordIndex
      .toString()
      .padStart(3, '0')}.png`,
  );
  fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
  return framePath;
}

function renderTextWithWordHighlight(
  ctx: SKRSContext2D,
  lines: string[],
  highlightWordIndex: number,
  options: ReelGeneratorOptions,
  startY: number,
  lineHeight: number,
): void {
  let wordIndex = 0;
  const centerX = options.slideWidth / 2;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineWords = line.split(' ');
    const y = startY + (lineIdx + 0.5) * lineHeight;

    const totalLineWidth = ctx.measureText(line).width;
    let currentX = centerX - totalLineWidth / 2;

    for (let i = 0; i < lineWords.length; i++) {
      const word = lineWords[i];
      const isHighlighted = wordIndex === highlightWordIndex;

      if (isHighlighted) {
        ctx.fillStyle = '#FFD700';
      } else {
        ctx.fillStyle = options.textColor;
      }
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#000000';

      ctx.strokeText(word, currentX, y);
      ctx.fillText(word, currentX, y);

      const wordWidth = ctx.measureText(word).width;
      const spaceWidth = ctx.measureText(' ').width;
      currentX += wordWidth + spaceWidth;

      wordIndex++;
    }
  }
}

/** Removes the listed files. The handler-level cleanup wipes the whole tempDir. */
export function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}
