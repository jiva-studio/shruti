import { computed, onMounted, type ComputedRef } from "vue"
import { messageToMarkdown, parseChatMarkers } from "@lectorium/composables/chatMarkers.js"
import { useVerseBodyStore } from "@lectorium/stores/useVerseBodyStore.js"
import { useCiteTranscriptStore } from "@lectorium/stores/useCiteTranscriptStore.js"
import { useCommentaryBodyStore } from "@lectorium/stores/useCommentaryBodyStore.js"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import { useCitationMetadata } from "../composables/useCitationMetadata.js"

/**
 * Copy / share export for one assistant message: resolves the cite
 * metadata + verse/transcript bodies and renders the message's raw
 * content to clean plain Markdown. Self-contained — extracted from
 * ChatMessageBubble so the bubble stays a thin renderer.
 */
export function useChatExportMarkdown(
  message: () => ChatMessage,
  appLanguage: () => string
): { exportMarkdown: ComputedRef<string>; citeTrackIds: ComputedRef<string[]> } {
  const verseBody = useVerseBodyStore()
  const citeTranscript = useCiteTranscriptStore()
  const commentaryBody = useCommentaryBodyStore()

  /** Unique track ids of the cites in this message — drives the async
   *  metadata resolution feeding the copy/share export. */
  const citeTrackIds = computed<string[]>(() => {
    const msg = message()
    if (msg.role !== "assistant") return []
    const ids = new Set<string>()
    for (const tok of parseChatMarkers(msg.content)) if (tok.kind === "cite") ids.add(tok.trackId)
    return [...ids]
  })
  const citeMeta = useCitationMetadata(
    () => citeTrackIds.value,
    () => appLanguage()
  )

  const exportMarkdown = computed<string>(() => {
    const msg = message()
    if (msg.role !== "assistant") return ""
    if (msg.streaming) return ""
    if (msg.error?.kind === "failed") return ""
    const lang: "ru" | "en" = appLanguage().startsWith("en") ? "en" : "ru"
    return messageToMarkdown(msg.content, {
      lang,
      verseLookup: (sourceId, tokens) => verseBody.get(sourceId, tokens),
      citeLookup: (trackId, startMs, endMs) => {
        const text = citeTranscript.get(trackId, startMs, endMs)
        if (!text) return null
        return { text, ...(citeMeta.value.get(trackId) ?? {}) }
      },
      commentaryLookup: (ref) => {
        const entry = commentaryBody.get(ref)
        if (!entry) return null
        return { text: entry.text, authorName: entry.authorName, addrLabel: entry.addrLabel }
      },
    })
  })

  onMounted(() => {
    // Hydrate the transcript + commentary caches so the copy/share export
    // can expand cites and purports in reopened history.
    void citeTranscript.hydrate()
    void commentaryBody.hydrate()
  })

  return { exportMarkdown, citeTrackIds }
}
