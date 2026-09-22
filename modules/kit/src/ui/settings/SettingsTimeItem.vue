<template>
  <SettingsItem :title="title" :subtitle="subtitle" button :detail="false" @activate="onActivate">
    <template v-if="$slots.icon" #icon><slot name="icon" /></template>
    <template #title><slot name="title" /></template>
    <template #trailing>
      <span slot="end" class="kit-settings-time-chip">
        <slot name="value">{{ display }}</slot>
      </span>
    </template>
  </SettingsItem>
</template>

<script setup lang="ts">
/**
 * Settings row for a time-of-day value (e.g. a daily reminder). Shows the current
 * `time` as a chip and emits `activate` on tap so the host can open its own time
 * picker; the host commits a new value by updating `v-model:time`.
 *
 * `time` is an `[hours, minutes]` tuple (24h). Display is zero-padded `HH : MM`,
 * overridable via the `value` slot. i18n-agnostic, no picker bundled.
 */
import { computed } from "vue"
import SettingsItem from "./SettingsItem.vue"

const props = withDefaults(
  defineProps<{
    /** Row title. */
    title?: string
    /** Row subtitle. */
    subtitle?: string
    /** Fallback shown when no time is set. */
    fallback?: [number, number]
  }>(),
  { fallback: () => [9, 0] }
)

const time = defineModel<[number, number] | undefined>("time", { default: undefined })

const emit = defineEmits<{
  /** The row was tapped — host may open a time picker. */
  activate: []
}>()

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

const display = computed<string>(() => {
  const [h, m] = time.value ?? props.fallback
  return `${pad(h)} : ${pad(m)}`
})

function onActivate(): void {
  emit("activate")
}
</script>

<style scoped>
.kit-settings-time-chip {
  background-color: var(--kit-settings-time-chip-bg, var(--ion-color-light-shade));
  padding: 0.25rem 0.5rem;
  border-radius: 5px;
  font-size: 0.8rem;
}
</style>
