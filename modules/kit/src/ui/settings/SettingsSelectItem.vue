<template>
  <SettingsItem :title="title" :subtitle="displaySubtitle" button detail @activate="onActivate">
    <template v-if="$slots.icon" #icon><slot name="icon" /></template>
    <template #title><slot name="title" /></template>
  </SettingsItem>
</template>

<script setup lang="ts">
/**
 * Settings row that surfaces a current choice and asks the host to open a chooser.
 *
 * Generic: the host owns the picker UI. On tap the row emits `activate` (so a
 * host can open its own action-sheet/dialog) and, when `options` is supplied,
 * the subtitle resolves the current `value` to its label automatically; the host
 * applies a pick by updating `v-model` and listening for `select`.
 *
 * i18n-agnostic (all labels via props), router-agnostic (no navigation), no store.
 */
import { computed } from "vue"
import SettingsItem from "./SettingsItem.vue"

interface SelectOption {
  id: string
  title: string
}

const props = defineProps<{
  /** Row title. */
  title?: string
  /** Selectable options. When given, the subtitle resolves `value` → its title. */
  options?: SelectOption[]
  /** Override the resolved subtitle (e.g. a free-form summary). */
  subtitle?: string
}>()

const value = defineModel<string>({ default: "" })

const emit = defineEmits<{
  /** The row was tapped — host may open a chooser. */
  activate: []
  /** The current value (for hosts that select inline). */
  select: [value: string]
}>()

const displaySubtitle = computed<string | undefined>(() => {
  if (props.subtitle !== undefined) return props.subtitle
  const match = props.options?.find((o) => o.id === value.value)
  return (match?.title ?? value.value) || undefined
})

function onActivate(): void {
  emit("activate")
  emit("select", value.value)
}
</script>
