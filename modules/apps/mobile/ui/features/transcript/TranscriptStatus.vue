<template>
  <div v-if="state === 'loading'" class="transcript-status transcript-loading">
    <IonSpinner name="crescent" />
    <p v-if="loadingMessage" class="transcript-loading-label">{{ loadingMessage }}</p>
  </div>
  <p v-else-if="state === 'error'" class="transcript-status transcript-error">
    {{ errorMessage }}
  </p>
  <p v-else-if="state === 'empty'" class="transcript-status transcript-empty">
    {{ emptyMessage }}
  </p>
</template>

<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"

defineProps<{
  /** `null` means the content is ready (renders nothing). */
  state: "loading" | "error" | "empty" | null
  /** Required when `state === 'error'`. */
  errorMessage?: string | null
  /** Required when `state === 'empty'`. */
  emptyMessage?: string
  /** Shown below the spinner when `state === 'loading'`. */
  loadingMessage?: string
}>()
</script>

<style scoped>
.transcript-status {
  display: flex;
  justify-content: center;
  align-items: center;
  color: white;
  opacity: 0.8;
  text-align: center;
  padding: 32px 16px;
  margin: 0;
}

.transcript-loading {
  /* Reserve enough vertical space inside the modal so the spinner +
     label land in the optical centre of the visible viewport, not
     pinned just under the header. IonContent is a scrolling container
     and doesn't expose a `flex: 1` slot for children, so we fall back
     to a viewport-relative min-height that accounts for the close
     button, header, and (optional) language selector above us. */
  flex-direction: column;
  gap: 12px;
  min-height: 70vh;
}

.transcript-loading-label {
  margin: 0;
  font-size: 14px;
}

.transcript-error {
  color: #ff8585;
  opacity: 1;
}
</style>
