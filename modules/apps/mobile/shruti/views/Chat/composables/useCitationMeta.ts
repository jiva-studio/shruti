import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useChatLanguage } from "@shruti/composables/useChatLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import type { AuthorId, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"
import type { ChatCiteSnippet } from "@lib/domain/chatMessage.js"

/** The fragment a citation card/chip points at. */
export interface CitationCoords {
  trackId: string
  startMs: number
  endMs: number
  caption?: string
}

export interface UseCitationMeta {
  /** Track / author for the cited fragment; null until loaded. */
  track: Ref<Track | null>
  author: Ref<Author | null>
  /** True once the track/author lookup has settled (hit, miss or error). */
  metaLoaded: Ref<boolean>
  /** Resolved lecture title (content language). */
  trackTitle: ComputedRef<string>
  /** Resolved author name (chat answer language). */
  authorName: ComputedRef<string>
}

/**
 * Resolve display attribution (track / author / title) for one cited
 * fragment. This is the read-only half of a citation surface — the part a
 * presentational card needs to render itself. The interactive half (the
 * Save / Studio / Playlist action sheet) lives in {@link useCitationActions},
 * which a HOST owns; a leaf card never launches a dialog of its own.
 */
export function useCitationMeta(
  coords: () => CitationCoords,
  fallback?: () => ChatCiteSnippet | null | undefined
): UseCitationMeta {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const chatLanguage = useChatLanguage()
  const libraryLanguages = useLibraryLanguages()

  // Labels (author / reference) follow the chat ANSWER language so the audio
  // citation's attribution matches the verse/commentary labels, which the
  // server bakes in the same answer language. Empty chatLanguage ⇒ UI language.
  const answerLanguage = computed<string>(() => chatLanguage.value || appLanguage.value)

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const metaLoaded = ref(false)

  // Primary source: attribution the server resolved in the answer language,
  // independent of what this device's catalog snapshot holds.
  const remote = computed<ChatCiteSnippet | null>(() => fallback?.() ?? null)

  /** @deprecated Compat for messages persisted before the server shipped
   *  attribution in the cite payload. */
  const localTitle = computed<string>(() => {
    if (!track.value) return ""
    // Title follows the content language (a library language the track has),
    // not the UI language — which still drives the author name label.
    const cl =
      preferredContentLanguage(track.value, libraryLanguages.value, appLanguage.value) ??
      appLanguage.value
    return resolveTrackTitle(track.value, cl) ?? ""
  })

  const trackTitle = computed<string>(() => remote.value?.trackTitle || localTitle.value)
  const authorName = computed<string>(
    () => remote.value?.authorName || resolveLocalizedName(author.value, answerLanguage.value) || ""
  )

  async function loadMetadata(): Promise<void> {
    try {
      const repos = app.repositories()
      const t0 = await repos.tracks.getById(coords().trackId as TrackId)
      track.value = t0 ?? null
      author.value =
        t0 && t0.authorId ? ((await repos.authors.getById(t0.authorId as AuthorId)) ?? null) : null
    } catch (err) {
      console.warn("[citation] metadata load failed", err)
    } finally {
      metaLoaded.value = true
    }
  }

  watch(
    () => coords().trackId,
    () => {
      track.value = null
      author.value = null
      metaLoaded.value = false
      void loadMetadata()
    },
    { immediate: true }
  )

  return { track, author, metaLoaded, trackTitle, authorName }
}
