<template>
  <IonItem lines="none" class="note" button :detail="false" @click="$emit('click', noteId)">
    <div class="body">
      <!--
        Caller-supplied content rendered above the quote — e.g. the
        Notes inline audio player. Composition root injects it via
        `<NotesList>`'s scoped slot so the UI layer doesn't need to
        reach into @lectorium / @lib/domain types itself.
      -->
      <slot name="player" />
      <HighlightText :text="text" :lang="language" />

      <div v-if="authorName || titleText || refDateText" class="meta-block">
        <div v-if="authorName" class="author">{{ authorName }}</div>
        <div v-if="titleText" class="title">{{ titleText }}</div>
        <div v-if="refDateText" class="meta">{{ refDateText }}</div>
      </div>
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

const titleText = computed<string>(() => props.trackTitle?.trim() ?? "")
// Шлока + дата на третьей строке. Разделитель — middle-dot (U+00B7).
const refDateText = computed<string>(() =>
  [props.reference, props.trackDate]
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

.meta-block {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.author {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}

.title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}

.meta {
  font-size: 0.75rem;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}
</style>
