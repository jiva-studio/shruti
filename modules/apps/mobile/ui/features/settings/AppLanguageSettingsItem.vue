<template>
  <SettingsSelectItem
    v-model="value"
    :title="$t('settings.appLanguage.title')"
    :subtitle="$t('settings.appLanguage.description')"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><LanguageIcon /></IconChip>
    </template>
  </SettingsSelectItem>

  <!-- Language Selection Dialog -->
  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.appLanguage.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { ref } from "vue"
import { SettingsSelectItem } from "@kit/ui"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { LanguageIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  items: { id: string; title: string }[]
}>()

const value = defineModel<string>({ required: true, default: "en" })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect(next?: string) {
  if (!next) return
  value.value = next
}
</script>
