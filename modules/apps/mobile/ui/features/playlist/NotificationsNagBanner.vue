<template>
  <div
    class="notifications-nag"
    role="button"
    tabindex="0"
    @click="$emit('enable')"
    @keydown.enter.prevent="$emit('enable')"
    @keydown.space.prevent="$emit('enable')"
  >
    <BellIcon class="notifications-nag-icon" :size="22" :stroke-width="2" />
    <div class="notifications-nag-body">
      <div class="notifications-nag-title">{{ $t("home.notificationsNag.title") }}</div>
      <div class="notifications-nag-description">
        {{ $t("home.notificationsNag.description") }}
      </div>
    </div>
    <button
      type="button"
      class="notifications-nag-dismiss"
      :aria-label="$t('home.notificationsNag.dismiss')"
      @click.stop="$emit('dismiss')"
    >
      <IconX :size="18" :stroke-width="2" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { IconX } from "@tabler/icons-vue"
import { BellIcon } from "@ui/icons/index.js"

defineEmits<{
  enable: []
  dismiss: []
}>()
</script>

<style scoped>
.notifications-nag {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin: 0.5rem 0.5rem 0.75rem;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ion-color-primary) 14%, var(--ion-background-color));
  border: 1px solid color-mix(in srgb, var(--ion-color-primary) 40%, transparent);
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.notifications-nag:active {
  opacity: 0.85;
}

.notifications-nag-icon {
  flex: 0 0 auto;
  color: var(--ion-color-primary-shade, var(--ion-color-primary));
}

.notifications-nag-body {
  flex: 1 1 auto;
  padding-right: 24px;
}

.notifications-nag-title {
  font-size: 1em;
  font-weight: 600;
  color: var(--ion-color-primary-shade, var(--ion-color-primary));
  margin-bottom: 2px;
}

.notifications-nag-description {
  font-size: 0.875em;
  color: var(--ion-text-color);
  line-height: 1.4;
}

.notifications-nag-dismiss {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: none;
  padding: 4px;
  color: var(--ion-color-primary-shade, var(--ion-color-primary));
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.notifications-nag-dismiss:active {
  opacity: 0.6;
}
</style>
