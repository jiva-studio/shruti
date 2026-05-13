<template>
  <IonItem lines="none" class="note" button :detail="false" @click="$emit('click', noteId)">
    <div class="body">
      <HighlightText :text="text" :lang="language" />

      <div v-if="authorName" class="author">{{ authorName }}</div>

      <div v-if="metaLine" class="meta">{{ metaLine }}</div>
    </div>
  </IonItem>
</template>

<script lang="ts" setup>
import { computed } from "vue"
import { IonItem } from "@ionic/vue"
import { HighlightText } from "@ui/primitives/index.js"

const props = defineProps<{
  noteId: string
  text: string
  language?: string
  authorName?: string
  trackTitle?: string
  trackDate?: string
  reference?: string
}>()

defineEmits<{ click: [noteId: string] }>()

// Single-line summary under the author: title · reference · date. Empty
// fields are skipped; if none are present the row is hidden entirely.
// Separator is the middle-dot (U+00B7) — `·`.
const metaLine = computed<string>(() =>
  [props.trackTitle, props.reference, props.trackDate]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" · ")
)
</script>

<style scoped>
.note {
  border-left: 5px solid;
  border-color: var(--ion-color-primary-tint);
  margin: 1rem 0rem;

  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.25rem 0;
  width: 100%;
}

.author {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--ion-color-medium);
  text-align: right;
}

.meta {
  font-size: 0.75rem;
  color: var(--ion-color-medium);
  text-align: left;
}
</style>
