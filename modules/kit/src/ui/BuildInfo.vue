<template>
  <p class="kit-build-info" @click="emit('tap')">
    <span class="kit-build-info-version">{{ versionText }}</span>
    <span v-if="dbScheme !== undefined || dbNumber !== undefined" class="kit-build-info-db">
      {{ dbText }}
    </span>
    <span v-for="id in debugIds" :key="id.label" class="kit-build-info-id">
      {{ id.label }} {{ id.value }}
    </span>
  </p>
</template>

<script setup lang="ts">
import { computed } from "vue"

/** A labelled debug identifier, shown only when the host decides to pass it. */
export interface BuildInfoId {
  label: string
  value: string
}

const props = defineProps<{
  /** App version string, e.g. "1.4.0". */
  version: string
  /** Build identifier (commit/CI number), e.g. "1234". */
  buildId: string
  /** Optional human build time, already formatted by the host. */
  buildTime?: string
  /** Optional storage/migration number. */
  dbNumber?: string | number
  /** Optional DB scheme/version. */
  dbScheme?: string | number
  /** Free-form debug identifiers (uids, customer ids). Host gates visibility. */
  debugIds?: BuildInfoId[]
}>()

const emit = defineEmits<{
  /** Emitted on tap — the host implements any debug-unlock logic. */
  tap: []
}>()

const versionText = computed(() => {
  const base = `v${props.version} (${props.buildId})`
  return props.buildTime ? `${base} · ${props.buildTime}` : base
})

const dbText = computed(() => {
  const number = props.dbNumber ?? "—"
  if (props.dbScheme === undefined) return `DB ${number}`
  return `DB ${number} · scheme ${props.dbScheme}`
})

const debugIds = computed(() => props.debugIds ?? [])
</script>

<style scoped>
.kit-build-info {
  font-size: 0.75em;
  color: var(--kit-build-info-fg, var(--ion-color-medium));
  text-align: center;
  margin-top: var(--kit-build-info-margin-top, 24px);
  padding: 12px 16px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 120ms ease;
}

.kit-build-info:active {
  opacity: 0.5;
}

.kit-build-info-db {
  display: block;
  margin-top: 2px;
  opacity: 0.75;
}

.kit-build-info-id {
  display: block;
  margin-top: 2px;
  opacity: 0.6;
  font-family: var(--kit-build-info-id-font, ui-monospace, monospace);
  word-break: break-all;
}
</style>
