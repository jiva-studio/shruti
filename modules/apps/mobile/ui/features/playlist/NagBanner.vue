<template>
  <div
    class="nag-banner"
    :class="`nag-banner--${variant}`"
    role="button"
    tabindex="0"
    @click="$emit('action')"
    @keydown.enter.prevent="$emit('action')"
    @keydown.space.prevent="$emit('action')"
  >
    <div class="nag-banner-body">
      <div class="nag-banner-title">{{ title }}</div>
      <div class="nag-banner-description">{{ description }}</div>
    </div>
    <button
      type="button"
      class="nag-banner-dismiss"
      :aria-label="dismissLabel"
      @click.stop="$emit('dismiss')"
    >
      <IconX :size="18" :stroke-width="2" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { IconX } from "@tabler/icons-vue"

// Dumb, presentational nag banner. It owns no show/hide logic and no copy —
// the parent decides which variant to render, with what text, and when.
defineProps<{
  variant: "primary" | "success"
  title: string
  description: string
  dismissLabel: string
}>()

defineEmits<{
  action: []
  dismiss: []
}>()
</script>

<style scoped>
.nag-banner {
  position: relative;
  padding: 10px 12px;
  margin: 0.5rem 0.5rem 0.75rem;
  border-radius: 6px;
  background: color-mix(in srgb, var(--nag-color) 14%, var(--ion-background-color));
  border: 1px solid color-mix(in srgb, var(--nag-color) 40%, transparent);
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.nag-banner--primary {
  --nag-color: var(--ion-color-primary);
  --nag-strong: var(--ion-color-primary-shade, var(--ion-color-primary));
}

.nag-banner--success {
  --nag-color: var(--ion-color-success);
  --nag-strong: var(--ion-color-success-shade, var(--ion-color-success));
}

.nag-banner:active {
  opacity: 0.85;
}

.nag-banner-title {
  font-size: 1em;
  font-weight: 600;
  color: var(--nag-strong);
  margin-bottom: 2px;
}

.nag-banner-description {
  font-size: 0.875em;
  color: var(--ion-text-color);
  line-height: 1.4;
}

.nag-banner-dismiss {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: none;
  padding: 4px;
  color: var(--nag-strong);
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.nag-banner-dismiss:active {
  opacity: 0.6;
}
</style>
