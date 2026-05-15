import * as fs from 'fs';
import OpenAI from 'openai';

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
  apiKey?: string;
  language?: string; // ISO-639-1 (e.g. "ru", "en")
}

/**
 * Whisper word-level transcription with per-word start/end timestamps.
 *
 * `language` is forwarded to the API as the `language` hint — significantly
 * improves WER and timestamp stability on short non-English clips where
 * auto-detect occasionally misfires.
 *
 * Auth: prefer the explicit `apiKey` argument; otherwise read
 * `SHRUTI_OPENAI_API_KEY` (the unified name used end-to-end). We do NOT
 * fall back to the SDK's default `OPENAI_API_KEY` lookup so a stale env
 * elsewhere can never silently take over.
 */
export async function transcribeAudioWithTimestamps(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const key = options.apiKey || process.env.SHRUTI_OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OpenAI API key missing — set SHRUTI_OPENAI_API_KEY or pass apiKey',
    );
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`audio file not found: ${audioPath}`);
  }

  const openai = new OpenAI({ apiKey: key });

  const transcription: any = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
    ...(options.language ? { language: options.language } : {}),
  });

  const text: string = transcription.text || '';
  const words: WordTimestamp[] = Array.isArray(transcription.words)
    ? transcription.words.map((w: any) => ({
        word: String(w.word).trim(),
        start: Number(w.start),
        end: Number(w.end),
      }))
    : [];

  return { text, words };
}
