<template>
  <div class="selection-actions">
    <IonButton color="dark" size="small" fill="clear" @click="emit('action', 'copy')">
      <IconCopyFilled slot="start" :size="20" />
    </IonButton>
    <IonButton
      v-if="mode !== 'existing'"
      size="small"
      color="dark"
      fill="clear"
      @click="emit('action', 'bookmark')"
    >
      <IconBookmarkFilled slot="start" :size="20" />
    </IonButton>
    <IonButton size="small" color="dark" fill="clear" @click="emit('action', 'share')">
      <IconShare slot="start" :size="20" />
    </IonButton>
    <IonButton
      v-if="mode === 'existing'"
      size="small"
      color="danger"
      fill="clear"
      @click="emit('action', 'delete')"
    >
      <IconTrashFilled slot="start" :size="20" />
    </IonButton>
  </div>
</template>

<script lang="ts" setup>
import { IonButton } from "@ionic/vue"
import { IconBookmarkFilled, IconCopyFilled, IconShare, IconTrashFilled } from "@tabler/icons-vue"

/**
 * Popover mode:
 *  - `selection` (default): user drag-selected fresh text → Copy /
 *    Bookmark / Share. Bookmark is the dominant CTA, Delete is hidden.
 *  - `existing`: user tapped a span already covered by a saved note →
 *    Copy / Share / Delete. The Bookmark button is suppressed (the span
 *    is already a note) and a red Delete button is appended.
 */
type SelectionMode = "selection" | "existing"

withDefaults(
  defineProps<{
    mode?: SelectionMode
  }>(),
  { mode: "selection" }
)

const emit = defineEmits<{
  action: [action: "copy" | "bookmark" | "share" | "delete"]
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
