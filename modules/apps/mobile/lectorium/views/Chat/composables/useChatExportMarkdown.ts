import { computed, type ComputedRef } from "vue"
import { messageToMarkdown, parseChatMarkers } from "@lib/chat/chatMarkers.js"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import { useCitationMetadata } from "../composables/useCitationMetadata.js"

/**
 * Copy / share export for one assistant message: resolves the cite
 * metadata + verse/transcript bodies (read straight off the message's own
 * `verses`/`cites`/`commentaries` maps) and renders the message's raw
 * content to clean plain Markdown. Self-contained — extracted from
 * ChatMessageBubble so the bubble stays a thin renderer.
 */
export function useChatExportMarkdown(
  message: () => ChatMessage,
  appLanguage: () => string
): { exportMarkdown: ComputedRef<string>; citeTrackIds: ComputedRef<string[]> } {
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
      verseLookup: (sourceId, tokens) => msg.verses?.[`${sourceId}|${tokens}`] ?? null,
      citeLookup: (trackId, startMs, endMs) => {
        const entry = msg.cites?.[`${trackId}|${startMs}-${endMs}`]
        if (!entry) return null
        return { text: entry.text, ...(citeMeta.value.get(trackId) ?? {}) }
      },
      commentaryLookup: (ref) => {
        const entry = msg.commentaries?.[String(ref)]
        if (!entry) return null
        return { text: entry.text, authorName: entry.authorName, addrLabel: entry.addrLabel }
      },
    })
  })

  return { exportMarkdown, citeTrackIds }
}
