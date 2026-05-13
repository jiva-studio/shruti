<template>
  <IonItemSliding>
    <slot />
    <IonItemOptions>
      <IonItemOption color="danger" @click="emit('delete')">
        <IconTrashFilled slot="icon-only" :size="24" />
      </IonItemOption>
    </IonItemOptions>
  </IonItemSliding>
</template>

<script setup lang="ts">
import { IonItemSliding, IonItemOptions, IonItemOption } from "@ionic/vue"
import { IconTrashFilled } from "@tabler/icons-vue"

const emit = defineEmits<{
  (e: "delete"): void
}>()
</script>
