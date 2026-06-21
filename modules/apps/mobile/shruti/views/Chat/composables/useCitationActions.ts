import { computed, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useChatActions } from "@shruti/composables/useChatActions.js"
import { useOpenInStudio } from "@shruti/composables/useOpenInStudio.js"
import { useToast } from "@kit/composables"
import { useCitationMeta, type CitationCoords, type UseCitationMeta } from "./useCitationMeta.js"

export type { CitationCoords } from "./useCitationMeta.js"

export interface CitationActionSheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

export interface UseCitationActions extends UseCitationMeta {
  actionSheetOpen: Ref<boolean>
  actionSheetButtons: ComputedRef<readonly CitationActionSheetButton[]>
  openActions: () => void
}

/**
 * The interactive half of a citation surface: the Save-as-note /
 * Open-in-Studio / Add-to-playlist action sheet, plus the display metadata it
 * composes from {@link useCitationMeta}. This is owned by a HOST that renders
 * `CitationActionSheet` — never by a leaf card, so a presentational card stays
 * dialog-free (e.g. the onboarding wisdom preview launches nothing).
 *
 * @param coords  Reactive getter for the cited fragment.
 * @param opts.snippetText  Optional getter for the known transcript text — the
 *   host passes it so a saved note carries the real fragment; without it
 *   `saveCitation` re-fetches.
 */
export function useCitationActions(
  coords: () => CitationCoords,
  opts: { snippetText?: () => string | null } = {}
): UseCitationActions {
  const { t } = useI18n()
  const toast = useToast()
  const { addToPlaylist } = useAddToPlaylist()
  const { saveCitation } = useChatActions()
  const { openInStudio } = useOpenInStudio()

  const meta = useCitationMeta(coords)
  const actionSheetOpen = ref(false)
  /** Reentrancy guard so a double-tap on Save doesn't create two notes. */
  const savingNote = ref(false)

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

  return {
    ...meta,
    actionSheetOpen,
    actionSheetButtons,
    openActions,
  }
}
