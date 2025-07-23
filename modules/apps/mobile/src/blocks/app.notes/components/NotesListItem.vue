<template>
  <IonItem
    lines="none"
    class="note"
  >
    <HighlightText
      :lang="language"
      :text="text"
    />
  </IonItem>
</template>


<script lang="ts" setup>
import { IonItem } from '@ionic/vue'
import { HighlightText } from '@blocks/app.ui.kit'


defineProps<{
  text: string
  language: string
  author: string,
  source: string,
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