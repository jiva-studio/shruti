<template>
  <IonItem
    lines="none"
    class="note"
  >
    <HighlightText
      :text="text"
      :lang="language"
    />
  </IonItem>
</template>


<script lang="ts" setup>
import { IonItem } from '@ionic/vue'
import { HighlightText } from '@blocks/app.ui.kit'

defineProps<{
  text: string
  author: string
  source: string
  language: string
  tags?: string[]
}>()
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