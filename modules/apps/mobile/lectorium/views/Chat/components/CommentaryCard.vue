<template>
  <!--
    Purport / prose-chapter / letter citation rendered as a card — the
    same `ExcerptCard` body the audio citation uses (quote text + author +
    reference), just without a player. The quote, author and reference
    ride the `commentary` SSE action payload (keyed by the marker's ref);
    a cache miss (evicted / pre-feature history) renders nothing, the
    marker simply disappears.
  -->
  <AccentFrame v-if="body" class="commentary-card">
    <AutoHeight>
      <ExcerptCard :text="displayText" :author-name="body.authorName" :reference="body.addrLabel" />
    </AutoHeight>
  </AccentFrame>

  <TranslationNotice v-if="body && isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useCommentaryBodyStore } from "@lectorium/stores/useCommentaryBodyStore.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"

const props = defineProps<{
  /** Integer ref from the `[commentary:N]` marker — the join key into the
   *  commentary body store where the SSE action stashed the quote. */
  commentaryRef: number
}>()

const store = useCommentaryBodyStore()

onMounted(() => {
  void store.hydrate()
})

const body = computed(() => store.get(props.commentaryRef))

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
