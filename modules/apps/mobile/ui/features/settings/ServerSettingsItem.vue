<script setup lang="ts">
import { ref } from "vue"
import { SettingsSelectItem } from "@kit/ui"
import { CloudIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"

defineProps<{
  items: { id: string; title: string }[]
}>()
const value = defineModel<string>({ required: true, default: "" })

const open = ref(false)

function onSelect(next?: string): void {
  if (!next) return
  value.value = next
}
</script>

<template>
  <SettingsSelectItem
    v-model="value"
    :title="$t('settings.preferredServer.title')"
    :options="items"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><CloudIcon /></IconChip>
    </template>
  </SettingsSelectItem>

  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.preferredServer.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>
