<template>
  <span class="marker" v-html="html" />
</template>

<script lang="ts" setup>
import { computed } from "vue"
import { renderInlineMarkdown } from "@lib/ui/transcript/renderInlineMarkdown.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  text: string
}>()

const html = computed(() => `[${renderInlineMarkdown(props.text)}] `)
</script>

<style scoped>
.marker {
  color: var(--ion-color-medium);
  font-style: italic;
  opacity: 0.7;
}
</style>
