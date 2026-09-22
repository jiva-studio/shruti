<template>
  <SettingsItem :title="title" :subtitle="subtitle" :disabled="disabled">
    <template v-if="$slots.icon" #icon><slot name="icon" /></template>
    <template #title><slot name="title" /></template>
    <template #subtitle><slot name="subtitle" /></template>
    <template #trailing>
      <IonToggle
        slot="end"
        :checked="checked"
        :disabled="disabled"
        label-placement="start"
        @ion-change="onChange"
      />
    </template>
  </SettingsItem>
</template>

<script setup lang="ts">
/**
 * Settings row with a trailing `IonToggle`. State is two-way via
 * `v-model:checked`; the toggle reads the controlled value so the host can veto
 * a flip (e.g. paywall) by simply not updating the model.
 *
 * i18n-agnostic (label text via props/slots), no domain, no store.
 */
import { IonToggle } from "@ionic/vue"
import SettingsItem from "./SettingsItem.vue"

defineProps<{
  /** Convenience for the default title slot. */
  title?: string
  /** Convenience for the default subtitle slot. */
  subtitle?: string
  /** Disable the row and its toggle. */
  disabled?: boolean
}>()

const checked = defineModel<boolean>("checked", { required: true, default: false })

function onChange(ev: CustomEvent): void {
  checked.value = (ev.detail as { checked: boolean }).checked
}
</script>
