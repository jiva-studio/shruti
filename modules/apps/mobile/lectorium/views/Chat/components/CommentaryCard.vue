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
      <ExcerptCard :text="displayText" :author-name="body.authorName" :reference="body.addrLabel" />
    </AutoHeight>
  </AccentFrame>

  <TranslationNotice v-if="body && isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import type { ChatCommentaryBody } from "@lib/domain/chatMessage.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"

const props = defineProps<{
  /** Commentary quote from the owning message's `commentaries` map (keyed
   *  by the `[commentary:N]` ref). Absent ⇒ the marker renders nothing. */
  body?: ChatCommentaryBody
}>()

const body = computed(() => props.body ?? null)

/** True when the shown quote is a machine translation with an original to
 *  flip to. */
const isMt = computed<boolean>(() => !!body.value?.mt && !!body.value?.textOriginal)
const showOriginal = ref(false)

/** Quote text: the original verbatim source when toggled (and available),
 *  otherwise the shown (possibly translated) text. */
const displayText = computed<string>(() => {
  const b = body.value
  if (!b) return ""
  return isMt.value && showOriginal.value && b.textOriginal ? b.textOriginal : b.text
})
</script>

<style scoped>
.commentary-card {
  margin: 10px 0;
  --excerpt-body-padding: 8px 12px 10px;
}
</style>
