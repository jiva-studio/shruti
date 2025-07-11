<template>
  <div class="selection-actions">
    <IonButton
      color="dark"
      size="small"
      fill="clear"
      @click="emit('action', 'copy')"
    >
      <IonIcon
        slot="start"
        :icon="copyOutline"
      />
      Copy
    </IonButton>
    <IonButton
      size="small"
      fill="clear"
      @click="emit('action', 'bookmark')"
    >
      <IonIcon
        slot="start"
        :icon="bookmark"
      />
      Bookmark
    </IonButton>
  </div>
</template>

<script lang="ts" setup>
import { IonButton, IonIcon } from '@ionic/vue'
import { copyOutline, bookmark } from 'ionicons/icons'

const emit = defineEmits<{
  action: [action: 'copy' | 'bookmark']
}>()
</script>


<style lang="css" scoped>
.selection-actions {
  display: flex;
  flex-direction: row;
  flex-grow: 1;
}

.button {
  flex-grow: 1;
  flex-basis: 1;
}
</style>