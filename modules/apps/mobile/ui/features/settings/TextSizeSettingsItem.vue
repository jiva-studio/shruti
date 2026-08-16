<template>
  <SettingsSelectItem
    :title="$t('settings.textSize.title')"
    :subtitle="format(scale)"
    @activate="open = true"
  >
    <template #icon>
      <IconChip><IconTextSize :size="22" /></IconChip>
    </template>
  </SettingsSelectItem>

  <ListItemSelectorDialog
    :open="open"
    :title="$t('settings.textSize.title')"
    :items="items"
    :value="String(scale)"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IconTextSize } from "@tabler/icons-vue"
import { SettingsSelectItem } from "@kit/ui"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { IconChip } from "@ui/primitives/index.js"

/**
 * How large the app renders text, as a multiplier on the root font size.
 *
 * The options are shown as percentages rather than named steps ("Large",
 * "Larger", …): the number is what the setting does, it needs no translating
 * beyond the locale's own digits and percent sign, and it stays honest when
 * the preset list changes.
 */
const props = defineProps<{
  /** Selectable multipliers; `1` is the size the app has always rendered at. */
  presets: readonly number[]
}>()

const scale = defineModel<number>("scale", { required: true })

const { locale } = useI18n()
const open = ref(false)

const items = computed(() =>
  props.presets.map((value) => ({ id: String(value), title: format(value) }))
)

function format(value: number): string {
  return new Intl.NumberFormat(locale.value, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value)
}

function onSelect(id: string | undefined): void {
  open.value = false
  if (id === undefined) return
  const next = Number(id)
  if (Number.isFinite(next)) scale.value = next
}
</script>
