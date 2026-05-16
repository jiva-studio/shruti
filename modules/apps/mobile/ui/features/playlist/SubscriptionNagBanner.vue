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
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  margin: 0 1rem 0.75rem;
  border-radius: 8px;
  background: var(--ion-color-step-50, var(--ion-color-light));
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.subscription-nag:active {
  opacity: 0.85;
}

.subscription-nag-body {
  flex: 1;
  min-width: 0;
}

.subscription-nag-title {
  font-size: 1em;
  font-weight: 600;
  color: var(--ion-text-color);
  margin-bottom: 2px;
}

.subscription-nag-description {
  font-size: 0.875em;
  color: var(--ion-color-medium-shade, var(--ion-color-medium));
  line-height: 1.4;
}

.subscription-nag-dismiss {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  padding: 4px;
  margin: -4px -4px 0 0;
  color: var(--ion-color-medium);
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
