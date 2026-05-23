/**
 * Request validation for POST /reels. Distilled from the legacy
 * eventAdapter.ts — same regex / limits, plain function on a JSON
 * payload (no Lambda event wrapping).
 */

const MAX_DURATION_MS = 120_000;
const MAX_TEXT_CHARS = 5_000;
const MAX_TITLE_CHARS = 120;
const SOURCE_KEY_RE = /^public\/(tracks|shares)\/[^\s]+\.mp3$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const THEME_RE = /^[a-z0-9_-]{1,32}$/;
const LANG_RE = /^[a-z]{2}$/;

export interface RenderRequest {
  sourceKey: string;
  startMs: number;
  endMs: number;
  text: string;
  lang: string;
  theme: string;
  videoId: string | null;
  title: string | null;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function parseRenderRequest(body: unknown): RenderRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object');
  }
  const p = body as Record<string, unknown>;

  const sourceKey = mustStr(p.source_key, 'source_key');
  if (!SOURCE_KEY_RE.test(sourceKey)) {
    throw new ValidationError('source_key must look like public/tracks/<id>/...mp3');
  }

  const startMs = mustInt(p.start_ms, 'start_ms');
  const endMs = mustInt(p.end_ms, 'end_ms');
  if (startMs < 0 || endMs <= startMs) {
    throw new ValidationError('end_ms must be greater than start_ms; both must be non-negative');
  }
  if (endMs - startMs > MAX_DURATION_MS) {
    throw new ValidationError(`excerpt longer than ${MAX_DURATION_MS / 1000}s is not supported`);
  }

  const text = mustStr(p.text, 'text');
  if (text.length > MAX_TEXT_CHARS) {
    throw new ValidationError(`text exceeds ${MAX_TEXT_CHARS} chars`);
  }

  const lang = mustStr(p.lang, 'lang').toLowerCase();
  if (!LANG_RE.test(lang)) {
    throw new ValidationError('lang must be ISO-639-1 (two lowercase letters)');
  }

  const theme = mustStr(p.theme, 'theme').toLowerCase();
  if (!THEME_RE.test(theme)) {
    throw new ValidationError('theme must match [a-z0-9_-]{1,32}');
  }

  let videoId: string | null = null;
  if (p.video_id != null) {
    const v = String(p.video_id);
    if (!VIDEO_ID_RE.test(v)) {
      throw new ValidationError('video_id must be alphanumeric / dash / underscore, max 64 chars');
    }
    videoId = v;
  }

  let title: string | null = null;
  if (p.title != null) {
    if (typeof p.title !== 'string') {
      throw new ValidationError('title must be a string');
    }
    const t = p.title.trim();
    if (t.length > 0) {
      if (t.length > MAX_TITLE_CHARS) {
        throw new ValidationError(`title exceeds ${MAX_TITLE_CHARS} chars`);
      }
      title = t;
    }
  }

  return { sourceKey, startMs, endMs, text, lang, theme, videoId, title };
}

function mustStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ValidationError(`${name} is required and must be a non-empty string`);
  }
  return v;
}

function mustInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(`${name} must be an integer`);
  }
  return n;
}
