import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useChatActions } from "@lectorium/composables/useChatActions.js"
import { useOpenInStudio } from "@lectorium/composables/useOpenInStudio.js"
import { useToast } from "@kit/composables"
import type { AuthorId, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"

/** The fragment a citation card/chip points at. */
export interface CitationCoords {
  trackId: string
  startMs: number
  endMs: number
  caption?: string
}

export interface CitationActionSheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

export interface UseCitationActions {
  /** Track / author for the cited fragment; null until loaded. */
  track: Ref<Track | null>
  author: Ref<Author | null>
  /** True once the track/author lookup has settled (hit, miss or error). */
  metaLoaded: Ref<boolean>
  /** Resolved lecture title — also the action-sheet header. */
  trackTitle: ComputedRef<string>
  /** Resolved author name. */
  authorName: ComputedRef<string>
  actionSheetOpen: Ref<boolean>
  actionSheetButtons: ComputedRef<readonly CitationActionSheetButton[]>
  openActions: () => void
}

/**
 * Shared behaviour for the two citation surfaces (CitationCard block +
 * CitationChip inline): loads the track/author metadata and owns the
 * Save-as-note / Open-in-Studio / Add-to-playlist action sheet. Each host
 * keeps only its own rendering.
 *
 * @param coords  Reactive getter for the cited fragment.
 * @param opts.snippetText  Optional getter for the known transcript text — the
 *   block card passes it so a saved note carries the real fragment; the chip
 *   leaves it undefined and `saveCitation` re-fetches.
 */
export function useCitationActions(
  coords: () => CitationCoords,
  opts: { snippetText?: () => string | null } = {}
): UseCitationActions {
  const { t } = useI18n()
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const toast = useToast()
  const { addToPlaylist } = useAddToPlaylist()
  const { saveCitation } = useChatActions()
  const { openInStudio } = useOpenInStudio()

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const metaLoaded = ref(false)
  const actionSheetOpen = ref(false)
  /** Reentrancy guard so a double-tap on Save doesn't create two notes. */
  const savingNote = ref(false)

  const trackTitle = computed<string>(() =>
    track.value ? (resolveTrackTitle(track.value, appLanguage.value) ?? "") : ""
  )
  const authorName = computed<string>(
    () => resolveLocalizedName(author.value, appLanguage.value) ?? ""
  )

  function openActions(): void {
    actionSheetOpen.value = true
  }

  function onOpenInStudio(): void {
    const c = coords()
    openInStudio({
      kind: "citation",
      trackId: c.trackId,
      startMs: c.startMs,
      endMs: c.endMs,
      caption: c.caption ?? "",
    })
  }

  async function onAddToPlaylist(): Promise<void> {
    try {
      await addToPlaylist(coords().trackId)
      await toast.info(t("chat.citationAddedToPlaylist"))
    } catch (err) {
      console.warn("[citation] add to playlist failed", err)
      await toast.error(t("chat.citationAddFailed"))
    }
  }

  async function onSaveAsNote(): Promise<void> {
    if (savingNote.value) return
    savingNote.value = true
    try {
      const c = coords()
      const text = opts.snippetText?.() ?? null
      await saveCitation({
        trackId: c.trackId,
        startMs: c.startMs,
        endMs: c.endMs,
        caption: c.caption ?? "",
        ...(text ? { text } : {}),
      })
    } finally {
      savingNote.value = false
    }
  }

  const actionSheetButtons = computed<readonly CitationActionSheetButton[]>(() => [
    { text: t("chat.citationSaveAsNote"), handler: () => void onSaveAsNote() },
    { text: t("chat.citationOpenInStudio"), handler: () => void onOpenInStudio() },
    { text: t("chat.citationAddLectureToPlaylist"), handler: () => void onAddToPlaylist() },
    { text: t("app.cancel"), role: "cancel", handler: () => undefined },
  ])

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

  return {
    track,
    author,
    metaLoaded,
    trackTitle,
    authorName,
    actionSheetOpen,
    actionSheetButtons,
    openActions,
  }
}
