import { WordTimestamp } from './transcribers';
import { Slide, WordTiming } from '../types';

/**
 * Force-align caller-provided text to Whisper word timings, then split the
 * aligned word stream into slides of at most `maxCharsPerSlide` characters.
 *
 * Why: caller's text has clean punctuation/casing that we want to render;
 * Whisper has reliable word boundaries we want to use for highlighting. We
 * pair them up so the rendered text is the caller's, but the timing is
 * Whisper's.
 *
 * Strategy:
 *   1. Tokenise caller text preserving punctuation in the surface form,
 *      stripped form for matching.
 *   2. Compute LCS between caller and Whisper token streams (stripped,
 *      lowercased). Aligned pairs inherit the Whisper timing exactly.
 *   3. Caller words with no aligned Whisper word interpolate timings from
 *      the surrounding aligned anchors.
 *   4. If the alignment is implausible (>50% size mismatch, or no caller
 *      words could be anchored), fall back to even distribution across
 *      [0, totalDuration].
 */
export function forceAlign(
  callerText: string,
  whisperWords: WordTimestamp[],
  totalDurationSec: number,
): WordTiming[] {
  const callerTokens = tokenise(callerText);

  // Empty edge cases
  if (callerTokens.length === 0) {
    // No caller words → render Whisper transcript unchanged
    return whisperWords.map((w) => ({ word: w.word, start: w.start, end: w.end }));
  }
  if (whisperWords.length === 0 || totalDurationSec <= 0) {
    return evenDistribution(callerTokens, totalDurationSec);
  }

  // Drastic size mismatch → don't trust the alignment
  const sizeRatio =
    Math.abs(callerTokens.length - whisperWords.length) /
    Math.max(callerTokens.length, whisperWords.length);
  if (sizeRatio > 0.5) {
    return evenDistribution(callerTokens, totalDurationSec);
  }

  const callerNorm = callerTokens.map((t) => t.normalised);
  const whisperNorm = whisperWords.map((w) => normalise(w.word));

  // Pair indices [callerIdx, whisperIdx] from the LCS.
  const pairs = lcsPairs(callerNorm, whisperNorm);

  // Build aligned timings; for non-anchored caller words, interpolate.
  const result: WordTiming[] = new Array(callerTokens.length);
  const anchoredCallerIdx: number[] = [];

  for (const [ci, wi] of pairs) {
    result[ci] = {
      word: callerTokens[ci].surface,
      start: whisperWords[wi].start,
      end: whisperWords[wi].end,
    };
    anchoredCallerIdx.push(ci);
  }

  // No anchors at all → fall back
  if (anchoredCallerIdx.length === 0) {
    return evenDistribution(callerTokens, totalDurationSec);
  }

  // Interpolate gaps between anchors
  let cursor = 0;
  for (let i = 0; i < callerTokens.length; i++) {
    if (result[i]) continue;

    // Find surrounding anchors
    while (cursor < anchoredCallerIdx.length && anchoredCallerIdx[cursor] < i) {
      cursor++;
    }
    const prevAnchor = cursor > 0 ? anchoredCallerIdx[cursor - 1] : -1;
    const nextAnchor =
      cursor < anchoredCallerIdx.length ? anchoredCallerIdx[cursor] : -1;

    const prevEnd = prevAnchor >= 0 ? result[prevAnchor].end : 0;
    const nextStart =
      nextAnchor >= 0
        ? result[nextAnchor].start
        : whisperWords[whisperWords.length - 1].end;

    // Distribute the unanchored words between prevEnd..nextStart proportionally
    const lowIdx = prevAnchor + 1;
    const highIdx = nextAnchor >= 0 ? nextAnchor : callerTokens.length;
    const span = Math.max(0.0, nextStart - prevEnd);
    const slots = highIdx - lowIdx;
    const slot = slots > 0 ? span / slots : 0;
    const offsetInGap = i - lowIdx;
    const start = prevEnd + slot * offsetInGap;
    const end = prevEnd + slot * (offsetInGap + 1);
    result[i] = {
      word: callerTokens[i].surface,
      start,
      end: Math.max(end, start + 0.05),
    };
  }

  return result;
}

/**
 * Group word timings into slides of at most `maxCharsPerSlide` characters.
 * Each slide's `startTime` / `endTime` / `duration` are derived from its
 * first/last word.
 */
export function wordsToSlides(words: WordTiming[], maxCharsPerSlide: number): Slide[] {
  if (words.length === 0) return [];

  const slides: Slide[] = [];
  let buf: WordTiming[] = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((w) => w.word).join(' ');
    const startTime = buf[0].start;
    const endTime = buf[buf.length - 1].end;
    slides.push({
      text,
      duration: Math.max(0.001, endTime - startTime),
      startTime,
      endTime,
      words: buf.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    });
    buf = [];
    bufLen = 0;
  };

  for (const w of words) {
    const additional = (bufLen === 0 ? 0 : 1) + w.word.length;
    if (bufLen + additional > maxCharsPerSlide && buf.length > 0) {
      flush();
    }
    buf.push(w);
    bufLen += (bufLen === 0 ? 0 : 1) + w.word.length;
  }
  flush();
  return slides;
}

interface CallerToken {
  surface: string;
  normalised: string;
}

function tokenise(text: string): CallerToken[] {
  return text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => ({ surface: t, normalised: normalise(t) }))
    .filter((t) => t.normalised.length > 0); // drop pure-punctuation tokens
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:'"«»„“”‘’()\[\]{}\-—–…]/g, '')
    .trim();
}

function evenDistribution(tokens: CallerToken[], totalDurationSec: number): WordTiming[] {
  const slot = totalDurationSec > 0 ? totalDurationSec / tokens.length : 0;
  return tokens.map((t, i) => ({
    word: t.surface,
    start: i * slot,
    end: (i + 1) * slot,
  }));
}

/**
 * Longest common subsequence of two string arrays.
 * Returns the matched pairs as [aIdx, bIdx]. O(n*m) time and space.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
