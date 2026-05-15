import * as fs from 'fs';
import OpenAI from 'openai';
import { Transcriber, TranscribeOptions, TranscriptionResult } from './types';

/**
 * OpenAI Whisper (model `whisper-1`) word-level transcription.
 *
 * NOT usable from Yandex Cloud — OpenAI returns 403 «Country, region, or
 * territory not supported» for requests originating from YC IP ranges.
 * Use the SpeechKit transcriber there instead.
 */
export function createWhisperTranscriber(): Transcriber {
  return {
    async transcribe(audioPath: string, options: TranscribeOptions): Promise<TranscriptionResult> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY missing');
      if (!fs.existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

      const openai = new OpenAI({ apiKey: key });
      const t: any = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
        ...(options.language ? { language: options.language } : {}),
      });

      return {
        text: t.text || '',
        words: Array.isArray(t.words)
          ? t.words.map((w: any) => ({
              word: String(w.word).trim(),
              start: Number(w.start),
              end: Number(w.end),
            }))
          : [],
      };
    },
  };
}
