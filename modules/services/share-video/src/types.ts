export interface ReelConfig {
  audioPath: string;
  outputPath: string;
  tempDir: string;
  slides: Slide[]; // Preassembled slides with word timings
  backgroundVideoPath: string; // Preconcatenated background MP4
  logoVideoPath?: string; // Optional logo clip to append at the end
  /**
   * Optional title-card overlay. When provided, the first ~0.5s of the reel
   * shows a cream-coloured static frame with the icon and centered title
   * instead of the normal text overlay. Audio is NOT shifted.
   */
  title?: string;
  /** PNG used by the title-card overlay. Required if `title` is set. */
  titleIconPath?: string;
  slideWidth?: number;
  slideHeight?: number;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  backgroundColor?: string; // Only used when no background video (kept for parity)
  maxCharsPerSlide?: number; // Used by upstream slide-splitter, not by ReelGenerator
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Slide {
  text: string;
  duration: number;
  startTime?: number;
  endTime?: number;
  words?: WordTiming[];
}

export interface ReelGeneratorOptions {
  slideWidth: number;
  slideHeight: number;
  backgroundColor: string;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  maxCharsPerSlide: number;
}
