export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  words: WordTimestamp[];
}

export interface TranscribeOptions {
  /** ISO-639-1 (e.g. "ru"); provider may map to its own locale tag. */
  language: string;
}

export interface Transcriber {
  transcribe(audioPath: string, options: TranscribeOptions): Promise<TranscriptionResult>;
}
