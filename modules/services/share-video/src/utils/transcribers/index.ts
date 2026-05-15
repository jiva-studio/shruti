import { S3Client } from '@aws-sdk/client-s3';
import { Transcriber } from './types';

export type { Transcriber, TranscribeOptions, TranscriptionResult, WordTimestamp } from './types';

/**
 * Pick a transcription provider via env:
 *   - TRANSCRIBER=whisper (default) — OpenAI Whisper. AWS Lambda.
 *   - TRANSCRIBER=speechkit — Yandex SpeechKit. YC functions (OpenAI is geo-blocked).
 *
 * Provider modules are loaded lazily so a function deployed with one
 * provider doesn't pay the cold-start cost of the other's dependencies
 * (e.g. AWS doesn't load the s3-request-presigner that only SpeechKit needs).
 *
 * Caller passes the S3 client + bucket so SpeechKit can stage the audio.
 */
export async function getTranscriber(deps: { s3: S3Client; bucket: string }): Promise<Transcriber> {
  const provider = (process.env.TRANSCRIBER || 'whisper').toLowerCase();
  switch (provider) {
    case 'whisper': {
      const { createWhisperTranscriber } = await import('./whisper');
      return createWhisperTranscriber();
    }
    case 'speechkit': {
      const apiKey = process.env.SPEECHKIT_API_KEY;
      if (!apiKey) throw new Error('SPEECHKIT_API_KEY missing for speechkit transcriber');
      const { createSpeechKitTranscriber } = await import('./speechkit');
      return createSpeechKitTranscriber({
        apiKey,
        s3: deps.s3,
        bucket: deps.bucket,
        scratchPrefix: process.env.TRANSCRIBE_SCRATCH_PREFIX || 'private/share/video/transcribe-scratch',
        storageEndpoint: process.env.S3_ENDPOINT_URL || 'https://storage.yandexcloud.net',
      });
    }
    default:
      throw new Error(`unknown TRANSCRIBER: ${provider}`);
  }
}
