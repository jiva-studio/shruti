import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, PlaylistItemId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { resolveTrackAuthorName } from "@lib/domain/services/trackAuthor.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"
import { useShruti } from "@shruti/shruti.js"

/**
 * Upper bound on the native playback queue handed over in one go. Each item
 * costs a `resolveLocalUrl` bridge round-trip at open time, so the tail is
 * capped — but it is capped on the *active list*, not on what Home happens to
 * have rendered.
 */
const QUEUE_SIZE = 50

export interface QueueSourceEntry {
  readonly item: { readonly id: PlaylistItemId }
  readonly track: Track
}

export interface PlaylistQueueBuilderReturn {
  /**
   * Build the native playback queue starting at `fromItemId` — that entry plus
   * every following one of the active playlist, in order, capped at
   * {@link QUEUE_SIZE}. Handing the whole tail over up front is what lets the
   * engine auto-advance while the JS layer is suspended.
   *
   * Each URL prefers the already-downloaded file (resolved without forcing a
   * download) and falls back to the public CDN URL. Entries without audio are
   * skipped.
   */
  buildFrom(
    entries: readonly QueueSourceEntry[],
    fromItemId: PlaylistItemId,
    preferredLanguage?: LanguageCode
  ): Promise<AudioQueueItem[]>
}

export function usePlaylistQueueBuilder(): PlaylistQueueBuilderReturn {
  const app = useShruti()

  async function resolveUrl(path: string): Promise<string> {
    const probe = buildServerUrl(app.activeServer.value, path)
    const local = await app.mediaDownloader.resolveLocalUrl(probe).catch(() => null)
    return local ?? app.storagePublicUrl.get(path)
  }

  async function resolveAuthorName(
    track: Track,
    variant: TrackVariant,
    cache: Map<AuthorId, Author | null>
  ): Promise<string> {
    let entity: Author | null = null
    if (track.authorId) {
      if (!cache.has(track.authorId)) {
        const repos = app.repositories()
        cache.set(track.authorId, await repos.authors.getById(track.authorId).catch(() => null))
      }
      entity = cache.get(track.authorId) ?? null
    }
    // Resolved identically to the list rows (buildTrackRow), personal-library
    // raw-author fallback included, so the lock screen and the list cannot
    // disagree on a track's author.
    return resolveTrackAuthorName(track, entity, variant.language)
  }

  async function buildFrom(
    entries: readonly QueueSourceEntry[],
    fromItemId: PlaylistItemId,
    preferredLanguage?: LanguageCode
  ): Promise<AudioQueueItem[]> {
    const startIdx = entries.findIndex((e) => e.item.id === fromItemId)
    if (startIdx < 0) return []
    const authorCache = new Map<AuthorId, Author | null>()
    const out: AudioQueueItem[] = []
    for (const { item, track } of entries.slice(startIdx, startIdx + QUEUE_SIZE)) {
      const variant = pickVariant(track, preferredLanguage)
      if (!variant?.audio) continue
      out.push({
        itemId: item.id,
        url: await resolveUrl(variant.audio.path),
        title: variant.title,
        author: await resolveAuthorName(track, variant, authorCache),
        // Both sides are already milliseconds — no ×1000.
        durationMs: variant.audio.duration ?? undefined,
      })
    }
    return out
  }

  return { buildFrom }
}

function pickVariant(track: Track, preferred?: LanguageCode): TrackVariant | undefined {
  if (preferred) {
    const v = track.variants.find((x) => x.language === preferred && x.audio)
    if (v) return v
  }
  return track.variants.find((v) => v.audio)
}
