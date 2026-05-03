<template>
  <IonItem button :detail="true" lines="none" @click="open = true">
    <div slot="start" class="settings-item-icon">
      <CloudIcon />
    </div>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.server.title") }}</h2>
      <p>{{ currentTitle }}</p>
    </IonLabel>
  </IonItem>

  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.server.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IonItem, IonLabel } from "@ionic/vue"
import { CloudIcon } from "@ui/icons/index.js"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"

interface Props {
  items: { id: string; title: string }[]
}

const props = defineProps<Props>()
const value = defineModel<string>({ required: true, default: "" })

const open = ref(false)

const currentTitle = computed(
  () => props.items.find((i) => i.id === value.value)?.title ?? value.value
)

function onSelect(next?: string): void {
  if (!next) return
  value.value = next
}
</script>
