<template>
  <!--
    Purport / prose-chapter / letter citation rendered as a card — the
    same `ExcerptCard` body the audio citation uses (quote text + author +
    reference), just without a player. The quote, author and reference
    ride the `commentary` SSE action payload (keyed by the marker's ref)
    and live on the owning message; a miss (pre-feature history) renders
    nothing, the marker simply disappears.
  -->
  <AccentFrame v-if="body" class="commentary-card">
    <AutoHeight>
      <ExcerptCard :text="displayHtml" :author-name="body.authorName" :reference="body.addrLabel" />
    </AutoHeight>
  </AccentFrame>

  <TranslationNotice v-if="body && isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { ChatCommentaryBody } from "@lib/domain/chatMessage.js"
import { inlineMd } from "@shruti/composables/chatMarkers.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"
import { useTranslatable } from "../composables/useTranslatable.js"

const props = defineProps<{
  /** Commentary quote from the owning message's `commentaries` map (keyed
   *  by the `[commentary:N]` ref). Absent ⇒ the marker renders nothing. */
  body?: ChatCommentaryBody
}>()

const body = computed(() => props.body ?? null)

// Translation toggle (show original ↔ machine translation), shared with
// CitationCard.
const { isMt, showOriginal, displayText } = useTranslatable(() => body.value)

/** Comment text rendered through the same inline-markdown pipeline the chat
 *  bubble uses, so bold / italic / code in server-provided commentary render
 *  instead of printing literally. `marked` escapes raw text by default; the
 *  result is consumed by `ExcerptCard` → `HighlightText` via `v-html`. */
const displayHtml = computed<string>(() => inlineMd(displayText.value))
</script>

<style scoped>
.commentary-card {
  margin: 10px 0;
  --excerpt-body-padding: 8px 12px 10px;
}

/* Inline markdown styles for the commentary text (inlineMd / marked
 * output), mirrored from ChatTokenRenderer. :deep penetrates the scope
 * into the v-html span rendered by HighlightText. */
.commentary-card :deep(strong) {
  font-weight: 600;
}
.commentary-card :deep(em) {
  font-style: italic;
}
.commentary-card :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
.commentary-card :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
</style>
