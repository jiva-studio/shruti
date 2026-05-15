import * as fs from 'fs';
import * as crypto from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Transcriber, TranscribeOptions, TranscriptionResult, WordTimestamp } from './types';

const RECOGNIZE_URL = 'https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync';
const OPERATIONS_URL = 'https://operation.api.cloud.yandex.net/operations';

export interface SpeechKitOptions {
  apiKey: string;
  s3: S3Client;
  bucket: string;
  /** Where the temp audio upload lives. Function must have RW on this prefix. */
  scratchPrefix: string;
  /** Where the bucket actually lives — used to build the audio source URI. */
  storageEndpoint?: string;
  /** Hard cap on poll wait. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Yandex SpeechKit v3 async file recognition with word-level timestamps.
 *
 * Flow:
 *   1. PUT cut audio into the scratch prefix on the function's bucket.
 *   2. POST to recognizeFileAsync with the audio's https:// URI on YC
 *      Object Storage — SpeechKit pulls the file itself.
 *   3. Poll the operation until done (typically 5-30s for our 60-120s clips).
 *   4. Flatten chunks/alternatives into a flat word stream.
 *   5. DELETE the scratch upload (best-effort; not fatal if it fails).
 */
export function createSpeechKitTranscriber(opts: SpeechKitOptions): Transcriber {
  const pollTimeoutMs = opts.pollTimeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;

  return {
    async transcribe(audioPath: string, options: TranscribeOptions): Promise<TranscriptionResult> {
      if (!fs.existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

      const scratchKey = `${opts.scratchPrefix.replace(/\/$/, '')}/${crypto.randomBytes(16).toString('hex')}.mp3`;

      // 1. Upload the cut audio to YC Object Storage.
      await opts.s3.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: scratchKey,
          Body: fs.readFileSync(audioPath),
          ContentType: 'audio/mpeg',
        }),
      );

      // Signed URL so SpeechKit can fetch the scratch file regardless of bucket policy.
      const audioUri = await getSignedUrl(
        opts.s3,
        new GetObjectCommand({ Bucket: opts.bucket, Key: scratchKey }),
        { expiresIn: 60 * 10 },
      );

      try {
        // 2. Start async recognition.
        const startBody = {
          uri: audioUri,
          recognitionModel: {
            model: 'general',
            audioFormat: { containerAudio: { containerAudioType: 'MP3' } },
            textNormalization: {
              textNormalization: 'TEXT_NORMALIZATION_ENABLED',
              profanityFilter: false,
              literatureText: false,
            },
            languageRestriction: {
              restrictionType: 'WHITELIST',
              languageCode: [toYcLocale(options.language)],
            },
          },
        };
        const startRes = await fetch(RECOGNIZE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Api-Key ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(startBody),
        });
        if (!startRes.ok) {
          throw new Error(`speechkit start ${startRes.status}: ${await startRes.text()}`);
        }
        const startJson: any = await startRes.json();
        const operationId = startJson.id;
        if (!operationId) {
          throw new Error(`speechkit: no operation id in response: ${JSON.stringify(startJson)}`);
        }

        // 3. Poll the operation.
        const deadline = Date.now() + pollTimeoutMs;
        let done: any = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const r = await fetch(`${OPERATIONS_URL}/${operationId}`, {
            headers: { Authorization: `Api-Key ${opts.apiKey}` },
          });
          if (!r.ok) throw new Error(`speechkit poll ${r.status}: ${await r.text()}`);
          const j: any = await r.json();
          if (j.done) {
            done = j;
            break;
          }
        }
        if (!done) throw new Error('speechkit: operation timed out');
        if (done.error) {
          throw new Error(`speechkit error: ${JSON.stringify(done.error)}`);
        }

        // 4. Parse result. v3 file-async returns { response: { chunks: [...] } }.
        return parseFileAsyncResult(done.response);
      } finally {
        // 5. Best-effort scratch cleanup.
        try {
          await opts.s3.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: scratchKey }));
        } catch (e: any) {
          console.warn(`speechkit scratch cleanup failed for ${scratchKey}: ${e?.message}`);
        }
      }
    },
  };
}

function parseFileAsyncResult(response: any): TranscriptionResult {
  // SpeechKit v3 file-async response shape:
  //   { chunks: [{ alternatives: [{ text, words: [{word, startTime, endTime}], ... }], channelTag }] }
  // OR streaming-result shape with finals — be defensive.
  const chunks: any[] = response?.chunks || response?.results || [];
  const text: string[] = [];
  const words: WordTimestamp[] = [];
  for (const chunk of chunks) {
    const alt = chunk?.alternatives?.[0] ?? chunk?.final?.alternatives?.[0];
    if (!alt) continue;
    if (alt.text) text.push(String(alt.text));
    for (const w of alt.words ?? []) {
      const word = String(w.word ?? w.text ?? '').trim();
      if (!word) continue;
      const start = parseDurationToSec(w.startTime ?? w.start_time ?? w.startTimeMs ?? w.start);
      const end = parseDurationToSec(w.endTime ?? w.end_time ?? w.endTimeMs ?? w.end);
      words.push({ word, start, end });
    }
  }
  return { text: text.join(' ').replace(/\s+/g, ' ').trim(), words };
}

/**
 * SpeechKit duration values are Google protobuf strings like "12.345s" — parse to seconds.
 * Tolerates plain numbers (already seconds) and ms-suffixed forms.
 */
function parseDurationToSec(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  let m = s.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(-?\d+(?:\.\d+)?)ms$/);
  if (m) return parseFloat(m[1]) / 1000;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const COMMON_LOCALE: Record<string, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  uk: 'uk-UA',
  kk: 'kk-KK',
  tr: 'tr-TR',
  uz: 'uz-UZ',
  de: 'de-DE',
};

function toYcLocale(iso639: string): string {
  return COMMON_LOCALE[iso639.toLowerCase()] ?? iso639;
}
