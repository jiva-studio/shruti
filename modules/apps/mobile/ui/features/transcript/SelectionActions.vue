<template>
  <div class="selection-actions">
    <IonButton color="dark" size="small" fill="clear" @click="emit('action', 'copy')">
      <IconCopyFilled slot="start" :size="20" />
    </IonButton>
    <IonButton size="small" color="dark" fill="clear" @click="emit('action', 'bookmark')">
      <IconBookmarkFilled slot="start" :size="20" />
    </IonButton>
    <IonButton size="small" color="dark" fill="clear" @click="emit('action', 'share')">
      <IconShare slot="start" :size="20" />
    </IonButton>
  </div>
</template>

<script lang="ts" setup>
import { IonButton } from "@ionic/vue"
import { IconBookmarkFilled, IconCopyFilled, IconShare } from "@tabler/icons-vue"

const emit = defineEmits<{
  action: [action: "copy" | "bookmark" | "share"]
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
