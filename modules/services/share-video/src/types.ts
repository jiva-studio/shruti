export interface ReelConfig {
  audioPath: string;
  text?: string; // Optional if using transcription
  outputPath: string;
  maxCharsPerSlide?: number;
  slideWidth?: number;
  slideHeight?: number;
  backgroundColor?: string;
  backgroundVideosFolder?: string; // Path to folder with background videos
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  transcribe?: boolean; // Set to true to auto-transcribe audio
  openaiApiKey?: string; // OpenAI API key for transcription
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Slide {
  text: string;
  duration: number;
  startTime?: number; // Start time in seconds
  endTime?: number;   // End time in seconds
  words?: WordTiming[]; // Word-level timings for highlighting
}

export interface ReelGeneratorOptions {
  maxCharsPerSlide: number;
  slideWidth: number;
  slideHeight: number;
  backgroundColor: string;
  textColor: string;
  fontSize: number;
  fontFamily: string;
}
