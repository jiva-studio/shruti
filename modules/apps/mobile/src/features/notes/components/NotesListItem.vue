<template>
  <IonItem
    lines="none"
    class="note"
  >
    <HighlightText
      :text="text"
    />
  </IonItem>
</template>


<script lang="ts" setup>
import { IonItem } from '@ionic/vue'
import { HighlightText } from '@lectorium/mobile/features/app.ui.kit'


defineProps<{
  text: string
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
}
</style>