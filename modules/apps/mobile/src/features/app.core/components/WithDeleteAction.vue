<template>
  <IonItemSliding>
    <slot />
    <IonItemOptions>
      <IonItemOption
        color="danger"
        @click="emit('delete')"
      >
        <IonIcon
          slot="icon-only"
          :icon="trashOutline"
        />
      </IonItemOption>
    </IonItemOptions>
  </IonItemSliding>
</template>

<script setup lang="ts">
import { IonItemSliding, IonItemOptions, IonItemOption, IonIcon } from '@ionic/vue'
import { trashOutline } from 'ionicons/icons'

const emit = defineEmits<{
  (e: 'delete'): void
}>()
</script>