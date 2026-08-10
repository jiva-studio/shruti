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
      <ExcerptCard
        :text="bodyHtml ?? ''"
        :author-name="body.authorName"
        :reference="body.addrLabel"
      />
    </AutoHeight>
  </AccentFrame>

  <!--
    Machine-translation toggle. The notice chrome (badge + "view original /
    translated" labels) is i18n-bearing, so it is rendered through a slot the
    parent owns: the app passes `TranslationNotice` (its default below, which
    reads global `$t`); a runtime without vue-i18n (web) can supply its own
    label-bearing chrome. Either way CommentaryCard only owns the toggle STATE
    and the `update:showOriginal` event.
  -->
  <slot
    v-if="body && isMt"
    name="translation-notice"
    :show-original="showOriginal"
    :toggle="() => emit('update:show-original', !showOriginal)"
    :set-show-original="(v: boolean) => emit('update:show-original', v)"
  >
    <TranslationNotice
      :show-original="showOriginal"
      @update:show-original="emit('update:show-original', $event)"
    />
  </slot>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { UiChatCommentaryBody } from "./types.js"
import { ExcerptCard } from "@lib/ui/excerpt/index.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"

const props = withDefaults(
  defineProps<{
    /** Commentary quote from the owning message's `commentaries` map (keyed
     *  by the `[commentary:N]` ref). Absent ⇒ the marker renders nothing. */
    body?: UiChatCommentaryBody
    /** Comment text pre-rendered to HTML by the host (renderExcerptHtml over
     *  the active translation). Consumed by `ExcerptCard` → `HighlightText`. */
    bodyHtml?: string
    /** True when the comment is a machine translation with an original to flip
     *  to — gates the TranslationNotice. Computed by the host. */
    isMt?: boolean
    /** Machine-translation toggle state, owned by the host. */
    showOriginal?: boolean
  }>(),
  { isMt: false, showOriginal: false }
)

const emit = defineEmits<{
  /** Fired when the user flips the machine-translation toggle. The host owns
   *  the toggle state and feeds it back via `showOriginal`. */
  (e: "update:show-original", value: boolean): void
}>()

const body = computed(() => props.body ?? null)
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
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
.commentary-card :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
/* `> …` block quote (e.g. a śloka quoted inside the purport): its own line,
 * italic, no literal `>`. No left rule — the card's own accent bar already
 * frames it; a second stripe on the nested verse reads as double-nesting. */
.commentary-card :deep(.excerpt-quote) {
  margin: 0.6em 0;
  font-style: italic;
  line-height: 1.4;
}
</style>
