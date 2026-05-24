import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import { pollUntilReady } from "@shruti/services/pollUntilReady.js"
import { useShruti } from "@shruti/shruti.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Module-scoped cache of resolved snippet URLs keyed by
 * `${trackId}|${startMs}|${endMs}`. Re-mounting the same CitationChip
 * (scroll-through, route navigation, message re-render) should not
 * re-probe the CDN nor re-invoke the share-audio cutter.
 */
const urlCache = new Map<string, string>()

/**
 * Public-bucket URL where the cut excerpt is expected to land. Mirrors
 * the predicted path used in NotesView.controller.ts so a snippet that
 * was already produced by Notes/Studio share is a cache-hit here.
 */
function predictedUrl(server: CdnServer, excerptId: string): string {
  return buildServerUrl(server, `public/shares/audio/${excerptId}.mp3`)
}

export interface CitationSnippetRef {
  readonly trackId: string
  readonly startMs: number
  readonly endMs: number
}

/**
 * Stable excerpt id for a (track, window) pair. Different from the
 * Notes share-audio id (which is `<noteId>` only) so chat citations
 * never collide with user notes in the public share bucket.
 */
export function citationExcerptId(ref: CitationSnippetRef): string {
  return `chat-cite-${ref.trackId}-${ref.startMs}-${ref.endMs}`
}

function cacheKey(ref: CitationSnippetRef): string {
  return `${ref.trackId}|${ref.startMs}|${ref.endMs}`
}

/**
 * Resolve a public URL for the snippet defined by `ref`. The flow
 * mirrors NotesView.controller.ts#onShareNoteAudioClicked:
 *  1. cache lookup (module-scoped Map) — instant rehydrate
 *  2. HEAD-probe the predictable CDN URL — skips the Lambda when the
 *     same window was generated before (e.g. another user's chat).
 *  3. cold path: call shareAudioService.cut(); if the cutter returns
 *     `ready:false`, HEAD-poll until the file lands.
 *
 * Throws when the track has no audio variant (translation-only). The
 * caller turns that into a user-facing toast.
 */
export function useCitationSnippet() {
  const { shareAudioService, activeServer, repositories } = useShruti()

  async function resolveUrl(ref: CitationSnippetRef): Promise<string> {
    const key = cacheKey(ref)
    const cached = urlCache.get(key)
    if (cached) return cached

    const track = await repositories().tracks.getById(ref.trackId as TrackId)
    if (!track) throw new Error("track-not-found")
    const variant = pickPlayableVariant(track)
    if (!variant || !variant.audio) throw new Error("no-audio")

    const excerptId = citationExcerptId(ref)
    const predicted = predictedUrl(activeServer.value, excerptId)

    // 1. Already on the CDN from a prior cut() — bail before invoking
    // the Lambda. Tolerate flaky HEAD: if probe explodes we treat it as
    // miss and fall through to cut(); cut() is idempotent on excerptId.
    const probe = await fetch(predicted, { method: "HEAD" }).catch(() => null)
    let url: string
    if (probe?.ok) {
      url = predicted
    } else {
      // 2. Cold path: ask the cutter, poll if async.
      const result = await shareAudioService.cut({
        sourceKey: variant.audio.path,
        startMs: ref.startMs,
        endMs: ref.endMs,
        excerptId,
      })
      url = result.url || predicted
      if (!result.ready) await pollUntilReady(url)
    }

    urlCache.set(key, url)
    return url
  }

  return { resolveUrl }
}
