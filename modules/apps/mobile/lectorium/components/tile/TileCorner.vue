<template>
  <IngestProgressBadge
    v-if="status === 'pending'"
    class="corner"
    :percent="progress?.percent"
    :label="progress?.label ?? ''"
  />
  <button
    v-else-if="status === 'failed' && canRetry"
    type="button"
    class="corner status failed as-button"
    @click.stop="emit('retry')"
  >
    <IconReload :size="13" />
    {{ $t("library.status.retry") }}
  </button>
  <span v-else-if="status === 'failed'" class="corner status failed">
    <IconAlertTriangle :size="13" />
    {{ $t("library.status.failed") }}
  </span>
  <button
    v-else-if="status === 'addable'"
    type="button"
    class="corner add"
    :aria-label="addLabel"
    @click.stop="emit('add')"
  >
    <IconPlus :size="18" />
  </button>
</template>

<script setup lang="ts">
import { IconAlertTriangle, IconReload, IconPlus } from "@tabler/icons-vue"
import IngestProgressBadge from "../IngestProgressBadge.vue"
import type { TileStatus } from "./status.js"

/** The one control a tile offers, whatever it currently is. */
withDefaults(
  defineProps<{
    status: TileStatus
    progress?: { label: string; percent?: number }
    /** A failed tile offers a retry only when there is something to retry. */
    canRetry?: boolean
    addLabel?: string
  }>(),
  { progress: undefined, canRetry: false, addLabel: "" }
)

const emit = defineEmits<{ add: []; retry: [] }>()
</script>

<style scoped>
.corner {
  position: absolute;
  top: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  z-index: 1;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}

.status.failed {
  background: var(--ion-color-danger, #eb445a);
}

.as-button {
  border: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* Same disc as the chat card's, so adding looks the same wherever offered. */
.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
</style>
