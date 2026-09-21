<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IconDatabase } from "@tabler/icons-vue"
import { SettingsSelectItem } from "@kit/ui"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { IconChip } from "@ui/primitives/index.js"
import { formatStorageSize } from "./formatStorageSize.js"

/**
 * How much disk downloaded lectures may occupy. The subtitle carries the
 * live figure ("1.4 GB of 8 GB") — without it the row is an abstract
 * number and the user can't tell whether they're near the wall.
 */
const props = defineProps<{
  /** Selectable budgets in bytes; `0` means "no limit". */
  presets: readonly number[]
  /** Bytes the downloaded audio currently occupies. */
  usedBytes: number
}>()

const limitBytes = defineModel<number>("limitBytes", { required: true })

const { t, locale } = useI18n()
const open = ref(false)

const items = computed(() =>
  props.presets.map((bytes) => ({
    id: String(bytes),
    title: bytes === 0 ? t("settings.downloadLimit.unlimited") : format(bytes),
  }))
)

const summary = computed(() => {
  const used = format(props.usedBytes)
  return limitBytes.value <= 0
    ? t("settings.downloadLimit.usageUnlimited", { used })
    : t("settings.downloadLimit.usage", { used, limit: format(limitBytes.value) })
})

function format(bytes: number): string {
  return formatStorageSize(bytes, locale.value)
}

function onSelect(id: string | undefined): void {
  open.value = false
  if (id === undefined) return
  const next = Number(id)
  if (Number.isFinite(next)) limitBytes.value = next
}
</script>

<template>
  <SettingsSelectItem
    :title="$t('settings.downloadLimit.title')"
    :subtitle="summary"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><IconDatabase :size="22" /></IconChip>
    </template>
  </SettingsSelectItem>

  <ListItemSelectorDialog
    :open="open"
    :title="$t('settings.downloadLimit.title')"
    :items="items"
    :value="String(limitBytes)"
    @close="open = false"
    @select="onSelect"
  />
</template>
