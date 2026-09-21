<script setup lang="ts">
import AccentFrame from "@lib/ui/chat/AccentFrame.vue"

// A markdown blockquote — a library document citation. Both fields come from
// `inlineMarkdownToHtml`, so the same v-html note as for a text token applies.
defineProps<{ bodyHtml: string; attributionHtml?: string }>()
</script>

<template>
  <AccentFrame class="chat-quote">
    <div class="chat-quote-body">
      <span v-html="bodyHtml" />
      <span v-if="attributionHtml" class="chat-quote-attribution" v-html="attributionHtml" />
    </div>
  </AccentFrame>
</template>

<style scoped>
.chat-quote {
  margin: 8px 0;
  color: inherit;
  line-height: 1.4;
}
.chat-quote-body {
  padding: 6px 12px;
}
.chat-quote-attribution {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-style: italic;
  color: var(--ion-color-medium, #777);
}

:deep(strong) {
  font-weight: 600;
}
:deep(em) {
  font-style: italic;
}
</style>
