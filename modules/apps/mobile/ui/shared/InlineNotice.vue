<template>
  <section :class="['inline-notice', kind]">
    <p v-if="title" class="title">{{ title }}</p>
    <p v-if="body" class="body">{{ body }}</p>
    <slot name="body" />
    <footer v-if="cta || $slots.cta" class="footer">
      <slot name="cta">
        <button v-if="cta" type="button" class="btn" :disabled="cta.disabled" @click="cta.action">
          {{ cta.label }}
        </button>
      </slot>
    </footer>
  </section>
</template>

<script setup lang="ts">
/**
 * Quiet inline notice — replaces the loud red `.error-card` that used
 * to wrap chat failures. Mirrors the action-card visual language
 * (tinted border + low-alpha background, no full-bleed colour) so a
 * row of state messages and action cards reads as one design family.
 *
 * Four `kind`s cover the surfaces this PR cares about:
 *   - error   — recoverable failures (network, server, auth). Danger
 *               tint at low alpha so it's recognisably "something
 *               broke" without screaming.
 *   - warning — non-actionable boundary hits (e.g. a Pro user blew
 *               through their 200 daily messages; nothing to fix,
 *               just wait).
 *   - info    — neutral status / explanation.
 *   - upsell  — quota-hit-for-a-non-Pro-user. Same warning tint as
 *               ActionCardUpgradeToPro so the user reads it as
 *               "tap to unlock", not "something's wrong".
 */
interface CtaSpec {
  readonly label: string
  readonly action: () => void
  readonly disabled?: boolean
}

defineProps<{
  kind: "error" | "warning" | "info" | "upsell"
  title?: string
  body?: string
  cta?: CtaSpec
}>()
</script>

<style scoped>
.inline-notice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border-width: 1px;
  border-style: solid;
}

/* Tinted-border + low-alpha-background pattern, same shape as
   ActionCardUpgradeToPro. Each kind swaps the Ionic colour token. */
.inline-notice.error {
  border-color: rgba(var(--ion-color-danger-rgb, 235 68 90), 0.32);
  background: rgba(var(--ion-color-danger-rgb, 235 68 90), 0.08);
}

.inline-notice.warning {
  border-color: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.42);
  background: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.1);
}

.inline-notice.upsell {
  border-color: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.45);
  background: rgba(var(--ion-color-warning-rgb, 255 196 9), 0.1);
}

.inline-notice.info {
  border-color: rgba(var(--ion-color-medium-rgb, 146 148 156), 0.35);
  background: rgba(var(--ion-color-medium-rgb, 146 148 156), 0.06);
}

.title {
  margin: 0;
  font-weight: 600;
  font-size: 15px;
  color: var(--ion-text-color);
}

.body {
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ion-color-medium);
}

.footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
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
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.inline-notice.upsell .btn {
  background: var(--ion-color-warning, #ffc409);
  color: var(--ion-color-warning-contrast, #000);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
