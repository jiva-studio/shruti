import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import type { DiscoveryHit } from "@lib/contracts"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useShruti } from "@shruti/shruti.js"

export function cleanExcerpt(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw
    .replace(/(?:\[|\()?\b\d{1,2}:\d{2}(?::\d{2})?\b(?:\]|\))?:?\s*/g, "")
    .replace(/^(?:speaker\s*\d*|spk\s*\d*|author):\s*/i, "")
    .replace(/^[\s\-–—:;.,]+/, "")
    .replace(/\s+/g, " ")
    .trim()
}

export interface UseWebLectureSummaryReturn {
  readonly summary: ComputedRef<string>
  readonly isLoading: ComputedRef<boolean>
  readonly isAiGenerated: ComputedRef<boolean>
}

function buildSummaryPrompt(hit: DiscoveryHit, cleaned: string, lang: string): string {
  const lines = [
    `Summarize this lecture in 2-3 concise sentences in ${lang}.`,
    `Focus on key themes and insights. Output only the plain summary text with no commentary or preambles.`,
    `Title: ${hit.title || "Untitled"}`,
  ]
  if (hit.author) lines.push(`Speaker: ${hit.author}`)
  if (hit.location) lines.push(`Location: ${hit.location}`)
  if (cleaned) lines.push(`Excerpt: ${cleaned}`)
  return lines.join("\n")
}

export function useWebLectureSummary(hit: Ref<DiscoveryHit | null>): UseWebLectureSummaryReturn {
  const app = useShruti()
  const appLanguage = useAppLanguage()

  const summary = ref<string>("")
  const isLoading = ref<boolean>(false)
  const isAiGenerated = ref<boolean>(false)
  let abortController: AbortController | null = null

  async function streamSummary(currentHit: DiscoveryHit, cleaned: string, signal: AbortSignal) {
    const lang = appLanguage.value || "en"
    const prompt = buildSummaryPrompt(currentHit, cleaned, lang)
    const turns = [{ role: "user" as const, content: prompt }]
    let accumulated = ""

    for await (const event of app.chatStreamClient.streamChat(turns, lang, { signal })) {
      if (signal.aborted) return
      if (event.type === "delta" && event.text) {
        accumulated += event.text
        summary.value = accumulated.trim()
        isAiGenerated.value = true
      }
    }
  }

  watch(
    hit,
    async (currentHit) => {
      if (abortController) {
        abortController.abort()
        abortController = null
      }

      if (!currentHit) {
        summary.value = ""
        isLoading.value = false
        isAiGenerated.value = false
        return
      }

      const cleaned = cleanExcerpt(currentHit.chunk)
      summary.value = cleaned
      isAiGenerated.value = false

      if (!cleaned && !currentHit.title) {
        isLoading.value = false
        return
      }

      const controller = new AbortController()
      abortController = controller
      isLoading.value = true

      try {
        await streamSummary(currentHit, cleaned, controller.signal)
      } catch {
        if (!isAiGenerated.value) summary.value = cleaned
      } finally {
        if (abortController === controller) {
          isLoading.value = false
          abortController = null
        }
      }
    },
    { immediate: true }
  )

  return {
    summary: computed(() => summary.value),
    isLoading: computed(() => isLoading.value),
    isAiGenerated: computed(() => isAiGenerated.value),
  }
}
