import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ListObjectsV2Command, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { concatClips } from './videoBackgrounds';

interface CacheEntry {
  keys: string[];
  expiresAt: number;
}
const listCache = new Map<string, CacheEntry>();
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;

const DOWNLOAD_CONCURRENCY = 4;

export interface BackgroundsOptions {
  bucket: string;
  prefix: string; // e.g. "private/share/video/backgrounds"
  theme: string;
  videoId: string; // used as deterministic shuffle seed
  durationSec: number;
  width: number;
  height: number;
  tempDir: string;
  s3: S3Client;
}

/**
 * List the theme's background pack from S3, deterministically pick enough
 * clips to cover `durationSec`, download in parallel, and concat into a
 * single MP4. Returns the path to the concatenated background video.
 *
 * Throws an Error with code "UNKNOWN_THEME" when the prefix is empty.
 */
export async function listAndConcatBackgrounds(
  opts: BackgroundsOptions,
): Promise<string> {
  const themePrefix = `${opts.prefix.replace(/\/$/, '')}/${opts.theme}/`;
  const keys = await listThemeKeys(opts.s3, opts.bucket, themePrefix);
  if (keys.length === 0) {
    const err = new Error(`unknown theme: ${opts.theme}`) as Error & { code?: string };
    err.code = 'UNKNOWN_THEME';
    throw err;
  }

  const nClips = Math.max(1, Math.ceil(opts.durationSec / 5));
  const ordered = pickClips(keys, opts.videoId, nClips);

  fs.mkdirSync(opts.tempDir, { recursive: true });
  const localPaths = await downloadAll(opts.s3, opts.bucket, ordered, opts.tempDir);

  const outPath = path.join(opts.tempDir, 'bg.mp4');
  await concatClips(localPaths, opts.durationSec, opts.width, opts.height, outPath, opts.tempDir);
  return outPath;
}

async function listThemeKeys(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const cacheKey = `${bucket}|${prefix}`;
  const cached = listCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.keys;
  }

  const all: string[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.Key.toLowerCase().endsWith('.mp4')) {
        all.push(obj.Key);
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  listCache.set(cacheKey, { keys: all, expiresAt: now + LIST_CACHE_TTL_MS });
  return all;
}

/**
 * Deterministic Fisher-Yates shuffle seeded by sha256(videoId), then take
 * the first `nClips` (cycling the shuffled list when the pack is smaller).
 */
function pickClips(allKeys: string[], videoId: string, nClips: number): string[] {
  const shuffled = seededShuffle(allKeys.slice(), videoId);
  const out: string[] = [];
  for (let i = 0; i < nClips; i++) {
    out.push(shuffled[i % shuffled.length]);
  }
  return out;
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  const rng = sha256Rng(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Stream a deterministic [0, 1) sequence by hashing seed||counter. */
function sha256Rng(seed: string): () => number {
  let counter = 0;
  return () => {
    const h = crypto.createHash('sha256').update(`${seed}|${counter++}`).digest();
    // Take first 6 bytes as a 48-bit integer, map to [0, 1).
    const big =
      h[0] * 2 ** 40 +
      h[1] * 2 ** 32 +
      h[2] * 2 ** 24 +
      h[3] * 2 ** 16 +
      h[4] * 2 ** 8 +
      h[5];
    return big / 2 ** 48;
  };
}

async function downloadAll(
  s3: S3Client,
  bucket: string,
  keys: string[],
  destDir: string,
): Promise<string[]> {
  const out: string[] = new Array(keys.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= keys.length) return;
      const dst = path.join(destDir, `bg_${i.toString().padStart(3, '0')}.mp4`);
      await downloadOne(s3, bucket, keys[i], dst);
      out[i] = dst;
    }
  };
  for (let w = 0; w < Math.min(DOWNLOAD_CONCURRENCY, keys.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

async function downloadOne(
  s3: S3Client,
  bucket: string,
  key: string,
  dst: string,
): Promise<void> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = resp.Body;
  if (!body || typeof (body as any).pipe !== 'function') {
    throw new Error(`unsupported S3 body for key ${key}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dst);
    (body as Readable).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    (body as Readable).on('error', reject);
  });
}
