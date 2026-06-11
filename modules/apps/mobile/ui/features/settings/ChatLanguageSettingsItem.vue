<template>
  <SettingsSelectItem
    v-model="value"
    :title="$t('settings.chatLanguage.title')"
    :subtitle="$t('settings.chatLanguage.description')"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><MessageIcon /></IconChip>
    </template>
  </SettingsSelectItem>

  <!-- Chat answer language Selection Dialog. Empty value means "follow the
       interface language"; the read site falls back to appLanguage. -->
  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.chatLanguage.title')"
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
import { MessageIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  items: { id: string; title: string }[]
}>()

const value = defineModel<string>({ required: true, default: "" })

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
