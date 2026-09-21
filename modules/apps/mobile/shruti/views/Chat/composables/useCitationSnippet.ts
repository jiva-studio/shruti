import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import { SHORT_POLL_TIMEOUT_MS, pollUntilReady } from "@lib/chat/utils/pollUntilReady.js"
import { useShruti } from "@shruti/shruti.js"
import { canonicalAudioPath, pickPlayableVariant, type Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

/** Re-mounting the same CitationChip must not re-probe the CDN nor re-invoke
 *  the cutter, so resolved URLs are cached for the process' lifetime. */
const urlCache = new Map<string, string>()

/** Where the cut excerpt is expected to land — the same path the Notes share
 *  predicts, so a snippet it produced is a cache-hit here. */
function predictedUrl(server: CdnServer, excerptId: string): string {
  return buildServerUrl(server, `public/shares/audio/${excerptId}.mp3`)
}

export interface CitationSnippetRef {
  readonly trackId: string
  readonly startMs: number
  readonly endMs: number
}

/** Stable excerpt id for a (track, window) pair, distinct from the Notes
 *  share-audio id so the two never collide in the public share bucket. */
export function citationExcerptId(ref: CitationSnippetRef): string {
  return `chat-cite-${ref.trackId}-${ref.startMs}-${ref.endMs}`
}

function cacheKey(ref: CitationSnippetRef): string {
  return `${ref.trackId}|${ref.startMs}|${ref.endMs}`
}

/**
 * The audio the excerpt is cut from. A track missing from the local catalog is
 * still playable — the key follows from its id; only a local, translation-only
 * track has no audio at all.
 */
export function pickSourceKey(track: Track | null | undefined, trackId: string): string {
  const variant = track ? pickPlayableVariant(track) : null
  if (track && !variant?.audio) throw new Error("no-audio")
  return variant?.audio?.path ?? canonicalAudioPath(trackId)
}

export function useCitationSnippet() {
  const { shareAudioService, activeServer, repositories } = useShruti()

  /** Tolerates a flaky HEAD: a failed probe is a miss, and `cut()` is
   *  idempotent on the excerpt id. Capped, or a half-open socket would hang
   *  the chip spinner for the platform's idle timeout instead. */
  async function isOnCdn(url: string): Promise<boolean> {
    const probe = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
    }).catch(() => null)
    return probe?.ok === true
  }

  /**
   * A public URL for the snippet: the cache, then a HEAD probe of the
   * predictable CDN URL, then the cutter with a poll if it answers async.
   *
   * Throws when the track has no audio at all (translation-only); the caller
   * turns that into a toast.
   */
  async function resolveUrl(ref: CitationSnippetRef): Promise<string> {
    const key = cacheKey(ref)
    const cached = urlCache.get(key)
    if (cached) return cached

    const track = await repositories().tracks.getById(ref.trackId as TrackId)
    const sourceKey = pickSourceKey(track, ref.trackId)

    const excerptId = citationExcerptId(ref)
    const predicted = predictedUrl(activeServer.value, excerptId)
    let url = predicted
    if (!(await isOnCdn(predicted))) {
      const result = await shareAudioService.cut({
        sourceKey,
        startMs: ref.startMs,
        endMs: ref.endMs,
        excerptId,
      })
      url = result.url || predicted
      if (!result.ready) await pollUntilReady(url, { timeoutMs: SHORT_POLL_TIMEOUT_MS })
    }

    urlCache.set(key, url)
    return url
  }

  return { resolveUrl }
}
