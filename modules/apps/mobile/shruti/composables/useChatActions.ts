import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useToast } from "@shruti/services/useToast.js"
import { saveCitationAsNote } from "@lib/application"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Thin Vue-aware wrapper around chat-related use-cases that fire from
 * presentation components (not from the chat store). Today it's just
 * "save citation as note" — invoked from `CitationChip` when the user
 * picks "Сохранить как заметку" from the three-dot menu. Other surfaces
 * that want the same flow (e.g. a track-view excerpt picker) can call
 * this composable instead of duplicating transcript-loading + overlap +
 * createNote against the repositories.
 */
export function useChatActions() {
  const app = useShruti()
  const notes = useNotesStore()
  const toast = useToast()
  const appLanguage = useAppLanguage()
  const { t } = useI18n()

  /** Returns true on success — caller can clear its local "saving"
   *  flag in finally. Toast feedback (in-flight + result) is fired
   *  here so the caller stays focused on the UX gate. */
  async function saveCitation(input: {
    trackId: string
    startMs: number
    endMs: number
    caption: string
    /** Preloaded snippet text (chat cite_transcript). When the card has
     *  it, the note body uses it verbatim instead of re-fetching the
     *  transcript (which the client may not hold). */
    text?: string
  }): Promise<boolean> {
    void toast.info(t("chat.noteSaving"))
    const result = await saveCitationAsNote(
      {
        trackId: input.trackId as TrackId,
        startMs: input.startMs,
        endMs: input.endMs,
        caption: input.caption,
        ...(input.text ? { text: input.text } : {}),
        preferredLanguage: appLanguage.value,
      },
      {
        notes: app.repositories().notes,
        transcripts: app.repositories().transcripts,
      }
    )
    if (!result.ok) {
      await toast.error(t("chat.actionNoteError"))
      return false
    }
    await notes.refresh()
    await toast.info(t("chat.noteSaved"))
    return true
  }

  return { saveCitation }
}
