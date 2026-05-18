import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Slide, ReelGeneratorOptions, WordTiming } from '../types';
import { registerFonts, FONT_FAMILY } from './fontManager';

/**
 * Cream background for the title-card frame. Chosen to read as warm/neutral
 * paper colour against the dark text and the icon's transparent edges.
 */
const TITLE_BG_COLOR = '#F5EBDC';
const TITLE_TEXT_COLOR = '#2A2A2A';

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

  // Parallel render: canvas.encode() releases the libuv thread pool, so the
  // 54-frame batch lights up all available vCPUs instead of one.
  return Promise.all(
    slides.map((slide, i) =>
      renderOneSlideImage(slide, options, useTransparentBackground, i, tempDir),
    ),
  );
}

async function renderOneSlideImage(
  slide: Slide,
  options: ReelGeneratorOptions,
  useTransparentBackground: boolean,
  slideIndex: number,
  tempDir: string,
): Promise<string> {
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

  // Layout constants scaled from the 1080p reference (40/30/8 there) by
  // 720/1080 = 2/3 so the proportions hold at the new 720p target.
  const padding = 27;
  const bgWidth = maxTextWidth + padding * 2;
  const bgHeight = totalHeight + padding * 1.5;
  const bgX = (options.slideWidth - bgWidth) / 2;
  const bgY = startY - padding * 0.75;
  const cornerRadius = 20;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.beginPath();
  ctx.roundRect(bgX, bgY, bgWidth, bgHeight, cornerRadius);
  ctx.fill();

  ctx.lineWidth = 5;
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = options.textColor;

  lines.forEach((line, index) => {
    const y = startY + (index + 0.5) * lineHeight;
    ctx.strokeText(line, options.slideWidth / 2, y);
    ctx.fillText(line, options.slideWidth / 2, y);
  });

  const imagePath = path.join(
    tempDir,
    `slide_${slideIndex.toString().padStart(3, '0')}.png`,
  );
  await fs.promises.writeFile(imagePath, await canvas.encode('png'));
  return imagePath;
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

  if (!slide.words || slide.words.length === 0) {
    const framePath = await generateSingleFrame(
      slide.text,
      options,
      useTransparentBackground,
      slideIndex,
      -1,
      tempDir,
    );
    return [
      {
        path: framePath,
        duration: slide.duration,
        startTime: slide.startTime || 0,
      },
    ];
  }

  // Each word's frame is independent — render in parallel. canvas.encode()
  // and fs.promises.writeFile both release the libuv thread pool, so a
  // multi-vCPU runtime actually parallelises instead of serialising.
  return Promise.all(
    slide.words.map(async (word, wordIndex) => {
      const framePath = await generateSingleFrame(
        slide.text,
        options,
        useTransparentBackground,
        slideIndex,
        wordIndex,
        tempDir,
        slide.words,
      );
      return {
        path: framePath,
        duration: word.end - word.start,
        startTime: word.start,
      };
    }),
  );
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

  // Layout constants scaled from the 1080p reference (40/30/8 there) by
  // 720/1080 = 2/3 so the proportions hold at the new 720p target.
  const padding = 27;
  const bgWidth = maxTextWidth + padding * 2;
  const bgHeight = totalHeight + padding * 1.5;
  const bgX = (options.slideWidth - bgWidth) / 2;
  const bgY = startY - padding * 0.75;
  const cornerRadius = 20;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.beginPath();
  ctx.roundRect(bgX, bgY, bgWidth, bgHeight, cornerRadius);
  ctx.fill();

  if (words && words.length > 0 && highlightWordIndex >= 0 && highlightWordIndex < words.length) {
    renderTextWithWordHighlight(ctx, lines, highlightWordIndex, options, startY, lineHeight);
  } else {
    ctx.lineWidth = 5;
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
  await fs.promises.writeFile(framePath, await canvas.encode('png'));
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
      ctx.lineWidth = 5;
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

/**
 * Render the title-card frame: opaque cream background, icon centered near
 * the top, multi-line title centered vertically. Used as a fixed overlay
 * during the first ~0.5s of the reel.
 */
export async function generateTitleFrame(
  title: string,
  iconPath: string,
  options: ReelGeneratorOptions,
  outputPath: string,
): Promise<string> {
  registerFonts();

  const canvas = createCanvas(options.slideWidth, options.slideHeight);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = TITLE_BG_COLOR;
  ctx.fillRect(0, 0, options.slideWidth, options.slideHeight);

  // Icon: square, ~25% of the slide width, anchored near the top.
  const iconSize = Math.round(options.slideWidth * 0.25);
  const iconX = (options.slideWidth - iconSize) / 2;
  const iconY = Math.round(options.slideHeight * 0.12);
  try {
    const img = await loadImage(iconPath);
    ctx.drawImage(img, iconX, iconY, iconSize, iconSize);
  } catch (e: any) {
    console.warn(`[share-video] title icon load failed (${iconPath}): ${e?.message}`);
  }

  const titleFontSize = Math.round(options.fontSize * 0.9);
  ctx.font = `bold ${titleFontSize}px ${FONT_FAMILY}, sans-serif`;
  ctx.fillStyle = TITLE_TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxTextWidth = options.slideWidth * 0.85;
  const lines = wrapText(ctx, title, maxTextWidth);
  const lineHeight = titleFontSize * 1.25;
  const totalHeight = lines.length * lineHeight;
  const centerY = options.slideHeight * 0.55;
  const startY = centerY - totalHeight / 2;

  lines.forEach((line, index) => {
    const y = startY + (index + 0.5) * lineHeight;
    ctx.fillText(line, options.slideWidth / 2, y);
  });

  await fs.promises.writeFile(outputPath, await canvas.encode('png'));
  return outputPath;
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
