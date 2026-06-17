<template>
  <SettingsSelectItem
    :title="$t('settings.libraryLanguages.title')"
    :subtitle="summary"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><LanguageIcon /></IconChip>
    </template>
  </SettingsSelectItem>

  <!-- Lecture-language selection dialog (multi-select, checkboxes) -->
  <MultiListItemSelectorDialog
    v-model:open="open"
    :value="selected"
    :title="$t('settings.libraryLanguages.title')"
    :items="items"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { SettingsSelectItem } from "@kit/ui"
import { MultiListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { LanguageIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const props = defineProps<{
  items: { id: string; title: string }[]
  selected: string[]
}>()

const emit = defineEmits<{ "update:selected": [string[]] }>()

const open = ref(false)

// Subtitle: the chosen languages, e.g. "English, Русский".
const summary = computed<string | undefined>(() => {
  const titles = props.selected.map((id) => props.items.find((i) => i.id === id)?.title ?? id)
  return titles.length > 0 ? titles.join(", ") : undefined
})

function onSelect(next: string[]): void {
  if (next.length > 0) emit("update:selected", next)
}
</script>
