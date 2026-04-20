<template>
  <IonItem
    lines="none"
    class="note"
    button
    :detail="false"
    @click="$emit('click', noteId)"
  >
    <HighlightText
      :text="text"
      :lang="language"
    />
  </IonItem>
</template>


<script lang="ts" setup>
import { IonItem } from '@ionic/vue'
import { HighlightText } from '@ui/primitives/index.js'

defineProps<{
  noteId: string
  text: string
  author?: string
  source?: string
  language?: string
  tags?: readonly string[]
}>()

defineEmits<{ click: [noteId: string] }>()
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
</style>
