<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import type { ActionState } from "@shruti/stores/useChatStore.js"

/**
 * Shared chrome for the interactive chat action cards (enable-reminder,
 * upgrade-to-pro, configure-smart-library, queue-next-track). Each card
 * supplies its head/body via slots + labels via props; this shell owns
 * the container, the pending→executing→done/error footer state machine,
 * and the degraded ("broken") fallback so that behaviour stays in one
 * place. `accent` switches the primary (default) vs warning palette.
 */
withDefaults(
  defineProps<{
    /** Whether the action payload is present. False → render the
     *  degraded placeholder instead of the card. */
    show: boolean
    state: ActionState
    title: string
    confirmLabel: string
    doneLabel: string
    errorLabel: string
    accent?: "primary" | "warning"
    /** Tighter padding for cards whose body brings its own (e.g. a
     *  TrackMiniRow). */
    dense?: boolean
  }>(),
  { accent: "primary", dense: false }
)

const emit = defineEmits<{
  (e: "confirm"): void
}>()
</script>

<template>
  <section v-if="show" class="action-card" :class="[accent, { dense }]">
    <header class="head">
      <slot name="head-start" />
      <span class="name">{{ title }}</span>
      <slot name="head-end" />
    </header>
    <slot />
    <footer class="footer">
      <span v-if="state === 'done'" class="hint">{{ doneLabel }}</span>
      <span v-else-if="state === 'error'" class="hint error">{{ errorLabel }}</span>
      <button v-if="state === 'pending'" class="btn primary" @click="emit('confirm')">
        {{ confirmLabel }}
      </button>
      <button v-else-if="state === 'executing'" class="btn primary" disabled>
        <IonSpinner name="dots" class="spinner" />
      </button>
      <button v-else-if="state === 'error'" class="btn primary" @click="emit('confirm')">
        {{ $t("chat.actionRetry") }}
      </button>
    </footer>
  </section>
  <section v-else class="action-card broken" :class="accent">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<style scoped>
.action-card {
  margin: 8px 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.action-card.dense {
  padding: 8px 12px 6px;
}

.action-card.warning {
  border-color: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.45);
  background: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.1);
}

.action-card.broken {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ion-color-medium);
  border: 1px dashed rgba(var(--ion-color-medium-rgb, 146, 148, 156), 0.5);
  background: transparent;
}

.broken-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.broken-text {
  flex: 1 1 auto;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.name {
  font-weight: 600;
  font-size: 15px;
  flex: 1 1 auto;
}

/* Card-supplied body paragraph — styled here so the four cards don't
 * each repeat it. */
.action-card :slotted(.body) {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ion-color-medium);
  line-height: 1.35;
}

.footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.btn {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  min-height: 30px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn.primary {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.action-card.warning .btn.primary {
  background: var(--ion-color-warning, #ffc409);
  color: var(--ion-color-warning-contrast, #000);
}

.btn.primary[disabled] {
  opacity: 0.6;
  cursor: default;
}

.spinner {
  width: 18px;
  height: 14px;
}

.hint {
  flex: 0 0 auto;
  font-size: 13px;
  padding: 6px 4px;
  opacity: 0.6;
}

.hint.error {
  color: var(--ion-color-danger, #eb445a);
  opacity: 0.85;
}
</style>
