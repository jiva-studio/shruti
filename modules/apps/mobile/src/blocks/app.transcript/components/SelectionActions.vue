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
      <!-- {{ $t("app.copy") }} -->
    </IonButton>
    <IonButton
      size="small"
      color="dark"
      fill="clear"
      @click="emit('action', 'bookmark')"
    >
      <IonIcon
        slot="start"
        :icon="bookmarkOutline"
      />
      <!-- {{ $t('app.save') }} -->
    </IonButton>
    <IonButton
      size="small"
      color="dark"
      fill="clear"
      @click="emit('action', 'share')"
    >
      <IonIcon
        slot="start"
        :icon="shareOutline"
      />
      <!-- {{ $t('app.share') }} -->
    </IonButton>
  </div>
</template>

<script lang="ts" setup>
import { IonButton, IonIcon } from '@ionic/vue'
import { copyOutline, bookmarkOutline, shareOutline } from 'ionicons/icons'

const emit = defineEmits<{
  action: [action: 'copy' | 'bookmark' | 'share']
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