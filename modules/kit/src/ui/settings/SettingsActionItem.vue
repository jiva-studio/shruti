<template>
  <SettingsItem
    :title="title"
    :subtitle="subtitle"
    :danger="danger"
    :disabled="disabled"
    :detail="detail"
    button
    @activate="onActivate"
  >
    <template v-if="$slots.icon" #icon><slot name="icon" /></template>
    <template #title><slot name="title" /></template>
    <template #subtitle><slot name="subtitle" /></template>
    <template v-if="$slots.trailing" #trailing><slot name="trailing" /></template>
  </SettingsItem>
</template>

<script setup lang="ts">
/**
 * Tappable settings row for a one-shot action (export/import, clear cache, open
 * help, destructive actions). On tap it emits `activate`; the host performs the
 * work. `danger` recolours the title for destructive actions.
 *
 * i18n-agnostic (text via props/slots), router-agnostic (host handles the tap).
 */
import SettingsItem from "./SettingsItem.vue"

defineProps<{
  /** Row title. */
  title?: string
  /** Row subtitle. */
  subtitle?: string
  /** Apply the danger palette (destructive action). */
  danger?: boolean
  /** Disable the row. */
  disabled?: boolean
  /** Show Ionic's trailing chevron. */
  detail?: boolean
}>()

const emit = defineEmits<{
  /** The row was tapped. */
  activate: []
}>()

function onActivate(): void {
  emit("activate")
}
</script>
