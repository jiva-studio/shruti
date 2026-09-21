import type { NoteShareContext } from "@usecases/notes/formatNoteShare.js"
import type { Track } from "@lib/domain/track.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { resolveLocalizedName } from "@lib/domain/services/localizedName.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import router from "@shruti/router/index.js"
import type { AskRequestParams } from "@shruti/composables/transcript/useTranscriptSelectionActions.js"

export interface AskSadhuDeps {
  readonly getTrack: () => Track | null | undefined
  readonly getShareContext: () => NoteShareContext["track"] | undefined
  readonly onError: (key: string) => void
}

/**
 * Open (or create) the track's focused chat session with the selected passage
 * as its focus card, then navigate to it.
 */
export function useAskSadhuFromTranscript(
  deps: AskSadhuDeps
): (params: AskRequestParams) => Promise<void> {
  const chatStore = useChatStore()
  const dictionaries = useDictionariesStore()
  const transcriptStore = useTranscriptStore()
  const appLanguage = useAppLanguage()

  /**
   * All bibliographic context is pinned at insert time so a later catalog
   * rename doesn't change the focus card's header. The source audio is
   * best-effort — without it the card renders with a disabled player.
   */
  function locationName(track: Track | null | undefined): string | undefined {
    const location = track?.locationId
      ? dictionaries.locationsById.get(track.locationId)
      : undefined
    return location ? resolveLocalizedName(location, appLanguage.value) : undefined
  }

  function buildFocus(params: AskRequestParams) {
    const track = deps.getTrack()
    const ctx = deps.getShareContext()
    const variant = track ? pickPlayableVariant(track) : null
    return {
      trackId: params.trackId,
      startMs: params.timeStart,
      endMs: params.timeEnd,
      text: params.text,
      sourceKey: variant?.audio?.path ?? undefined,
      trackTitle: ctx?.title,
      authorName: ctx?.authorName,
      date: ctx?.date,
      location: locationName(track),
    }
  }

  return async (params) => {
    const focus = buildFocus(params)
    // Prep chat state FIRST, while the transcript modal is still mounted, so
    // the store calls reach the user DB without racing its teardown.
    try {
      const sessionId = await chatStore.openOrCreateFocusedSession(params.trackId)
      const focusMessageId = await chatStore.appendFocusMessage(focus)
      // Fire-and-forget — chips land on the focus message's `followups` once
      // /questions resolves (or `[]`, which the card reads as "use the static
      // i18n fallback").
      void chatStore.requestSuggestions(focusMessageId, focus)
      chatStore.requestInputFocus()
      // Navigate BEFORE dismissing the modal: closing first lets ChatView's
      // route watcher re-fire against the stale path and start a new session
      // over the one just set up.
      await router.push({ name: "chat", query: { session: sessionId } })
      transcriptStore.close()
    } catch (err) {
      console.warn("[transcript] ask-sadhu dispatch failed:", err)
      deps.onError("errors.askFailed")
    }
  }
}
