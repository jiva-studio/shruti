<template>
  <div v-if="state === 'loading'" class="transcript-status">
    <IonSpinner name="crescent" />
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

.transcript-error {
  color: #ff8585;
  opacity: 1;
}
</style>
