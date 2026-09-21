import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { useCachedExcerptUrl } from "@shruti/composables/useCachedExcerptUrl.js"
import { useCitationSnippet, type CitationSnippetRef } from "./useCitationSnippet.js"

/**
 * The playable URL for one citation's excerpt, resolved on first play and kept
 * for the chip's lifetime. A failure is reported to the user and answered with
 * null, so the caller simply does not play.
 */
export function useCitationChipUrl(ref_: () => CitationSnippetRef): () => Promise<string | null> {
  const { t } = useI18n()
  const toast = useToast()
  const { resolveUrl } = useCitationSnippet()
  const { resolve: resolveCachedUrl } = useCachedExcerptUrl()
  const cached = ref<string | null>(null)

  return async function ensureUrl(): Promise<string | null> {
    if (cached.value) return cached.value
    const snippetRef = ref_()
    try {
      cached.value = await resolveCachedUrl(() => resolveUrl(snippetRef))
      return cached.value
    } catch (err) {
      const code = (err as Error)?.message
      const known = code === "no-audio" || code === "track-not-found"
      console.warn(`[citation-chip] ${known ? code : "resolve failed"}`, snippetRef, err)
      await toast.error(t(known ? "chat.citationNoAudio" : "chat.citationLoadFailed"))
      return null
    }
  }
}
