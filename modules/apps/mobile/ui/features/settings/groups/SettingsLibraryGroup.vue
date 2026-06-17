<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.library") }}</IonLabel>
  </IonListHeader>

  <IonItem lines="full">
    <IonLabel class="ion-text-wrap hint">
      {{ $t("settings.libraryLanguages.description") }}
    </IonLabel>
  </IonItem>

  <IonItem v-for="item in languageItems" :key="item.id" lines="full">
    <IonLabel>{{ item.title }}</IonLabel>
    <IonToggle
      slot="end"
      :checked="selected.includes(item.id)"
      :disabled="selected.length === 1 && selected.includes(item.id)"
      @ion-change="onToggle(item.id, $event.detail.checked)"
    />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader, IonToggle } from "@ionic/vue"

interface SelectorItem {
  id: string
  title: string
}

// Content languages the user wants to see lectures in. At least one must stay
// selected — the last enabled language's toggle is disabled, and the handler
// refuses to clear the final one — so discovery never filters down to nothing.
const props = defineProps<{
  languageItems: SelectorItem[]
  selected: string[]
}>()

const emit = defineEmits<{ "update:selected": [string[]] }>()

function onToggle(id: string, on: boolean): void {
  const set = new Set(props.selected)
  if (on) {
    set.add(id)
  } else {
    if (props.selected.length <= 1) return // keep at least one
    set.delete(id)
  }
  emit("update:selected", [...set])
}
</script>

<style scoped>
.hint {
  font-size: 14px;
  color: var(--ion-color-medium-shade);
}
</style>
