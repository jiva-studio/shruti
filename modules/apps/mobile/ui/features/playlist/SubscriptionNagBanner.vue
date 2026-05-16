<template>
  <div
    class="subscription-nag"
    role="button"
    tabindex="0"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <div class="subscription-nag-body">
      <div class="subscription-nag-title">{{ $t("home.subscriptionNag.title") }}</div>
      <div class="subscription-nag-description">
        {{ $t("home.subscriptionNag.description") }}
      </div>
    </div>
    <button
      type="button"
      class="subscription-nag-dismiss"
      :aria-label="$t('home.subscriptionNag.dismiss')"
      @click.stop="$emit('dismiss')"
    >
      <IconX :size="18" :stroke-width="2" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { IconX } from "@tabler/icons-vue"

defineEmits<{
  open: []
  dismiss: []
}>()
</script>

<style scoped>
.subscription-nag {
  position: relative;
  padding: 10px 12px;
  margin: 0.5rem 0.5rem 0.75rem;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ion-color-success) 16%, var(--ion-background-color));
  border: 1px solid color-mix(in srgb, var(--ion-color-success) 40%, transparent);
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.subscription-nag:active {
  opacity: 0.85;
}

.subscription-nag-body {
  padding-right: 24px;
}

.subscription-nag-title {
  font-size: 1em;
  font-weight: 600;
  color: var(--ion-color-success-shade, var(--ion-color-success));
  margin-bottom: 2px;
}

.subscription-nag-description {
  font-size: 0.875em;
  color: var(--ion-text-color);
  line-height: 1.4;
}

.subscription-nag-dismiss {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: none;
  padding: 4px;
  color: var(--ion-color-success-shade, var(--ion-color-success));
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.subscription-nag-dismiss:active {
  opacity: 0.6;
}
</style>
