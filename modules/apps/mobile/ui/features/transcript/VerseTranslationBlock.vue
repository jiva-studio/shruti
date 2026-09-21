<script lang="ts" setup>
import { computed } from "vue"
import { renderInlineMarkdown } from "@lib/ui/transcript/renderInlineMarkdown.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  text: string
}>()

const html = computed(() => renderInlineMarkdown(props.text) + " ")
</script>

<template>
  <span class="VerseTranslationBlock">
    <span v-html="html" />
  </span>
</template>

<style scoped>
.VerseTranslationBlock {
  font-weight: bold;
}
</style>
