<template>
  <!-- queued / processing: a spinner + label; the item is being ingested. -->
  <span v-if="status === 'queued' || status === 'processing'" class="badge processing">
    <IonSpinner name="dots" class="spinner" />
    <span class="label">{{ $t("library.status.processing") }}</span>
  </span>

  <!-- span[role=button], not <button>: it nests inside the card's <button>. -->
  <span
    v-else-if="status === 'failed'"
    class="badge failed"
    role="button"
    tabindex="0"
    @click.stop="emit('retry')"
    @keydown.enter.stop.prevent="emit('retry')"
    @keydown.space.stop.prevent="emit('retry')"
  >
    <IconAlertTriangle :size="14" />
    <span class="label">{{ $t("library.status.retry") }}</span>
  </span>

  <!-- ready: a subtle "ready" chip (no CTA — the card itself is tappable). -->
  <span v-else class="badge ready">
    <IconCheck :size="14" />
    <span class="label">{{ $t("library.status.ready") }}</span>
  </span>
</template>

<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import { IconAlertTriangle, IconCheck } from "@tabler/icons-vue"
import type { LibraryItemStatus } from "@lib/domain/libraryItem.js"

/**
 * Status pill for a personal-library item. `processing`/`queued` show a
 * spinner, `failed` is a tappable retry chip (emits `retry`), `ready` a
 * quiet confirmation. Server-authored status; the client only renders it.
 */
defineProps<{ status: LibraryItemStatus }>()

const emit = defineEmits<{ (e: "retry"): void }>()
</script>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.badge .label {
  min-width: 0;
}

.spinner {
  width: 14px;
  height: 12px;
}

.processing {
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
}

.ready {
  background: rgba(var(--ion-color-success-rgb, 45 211 111), 0.16);
  color: var(--ion-color-success, #2dd36f);
}

.failed {
  background: rgba(var(--ion-color-danger-rgb, 235 68 90), 0.14);
  color: var(--ion-color-danger, #eb445a);
  cursor: pointer;
}
</style>
