/**
 * Normalise the incoming HTTP event (AWS HTTP API v2 / YC API Gateway) into
 * a typed request and validate inputs. Mirrors share-audio/event_adapter.py.
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
  videoId: string | null; // null → handler generates UUID
  title: string | null;   // null → no title-card overlay at the start
}

export function parseRequest(event: any): RenderRequest {
  const payload = extractPayload(event);

  const sourceKey = str(payload.source_key, 'source_key');
  if (!SOURCE_KEY_RE.test(sourceKey)) {
    throw err('source_key must look like public/tracks/<id>/...mp3');
  }

  const startMs = int(payload.start_ms, 'start_ms');
  const endMs = int(payload.end_ms, 'end_ms');
  if (startMs < 0 || endMs <= startMs) {
    throw err('end_ms must be greater than start_ms; both must be non-negative');
  }
  if (endMs - startMs > MAX_DURATION_MS) {
    throw err(`excerpt longer than ${MAX_DURATION_MS / 1000}s is not supported`);
  }

  const text = str(payload.text, 'text');
  if (text.length > MAX_TEXT_CHARS) {
    throw err(`text exceeds ${MAX_TEXT_CHARS} chars`);
  }

  const lang = str(payload.lang, 'lang').toLowerCase();
  if (!LANG_RE.test(lang)) {
    throw err('lang must be ISO-639-1 (two lowercase letters)');
  }

  const theme = str(payload.theme, 'theme').toLowerCase();
  if (!THEME_RE.test(theme)) {
    throw err('theme must match [a-z0-9_-]{1,32}');
  }

  let videoId: string | null = null;
  if (payload.video_id != null) {
    const v = String(payload.video_id);
    if (!VIDEO_ID_RE.test(v)) {
      throw err('video_id must be alphanumeric / dash / underscore, max 64 chars');
    }
    videoId = v;
  }

  let title: string | null = null;
  if (payload.title != null) {
    if (typeof payload.title !== 'string') {
      throw err('title must be a string');
    }
    const t = payload.title.trim();
    if (t.length > 0) {
      if (t.length > MAX_TITLE_CHARS) {
        throw err(`title exceeds ${MAX_TITLE_CHARS} chars`);
      }
      title = t;
    }
  }

  return { sourceKey, startMs, endMs, text, lang, theme, videoId, title };
}

function extractPayload(event: any): Record<string, any> {
  if (event && typeof event === 'object' && 'body' in event) {
    let body = (event as any).body;
    if ((event as any).isBase64Encoded && typeof body === 'string') {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        throw err('body is not valid JSON');
      }
    }
    if (body && typeof body === 'object') return body;
  }
  if (event && typeof event === 'object') return event;
  throw err('unsupported event shape');
}

export function requestMethod(event: any): string {
  if (!event || typeof event !== 'object') return '';
  const ctx = (event as any).requestContext;
  const httpInfo = ctx && typeof ctx === 'object' ? (ctx as any).http : undefined;
  if (httpInfo && typeof httpInfo === 'object' && typeof httpInfo.method === 'string') {
    return httpInfo.method.toUpperCase();
  }
  if (typeof (event as any).httpMethod === 'string') {
    return ((event as any).httpMethod as string).toUpperCase();
  }
  return '';
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw err(`${name} is required and must be a non-empty string`);
  }
  return v;
}

function int(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw err(`${name} must be an integer`);
  }
  return n;
}

function err(msg: string): Error {
  const e = new Error(msg) as Error & { http?: number };
  e.http = 400;
  return e;
}
