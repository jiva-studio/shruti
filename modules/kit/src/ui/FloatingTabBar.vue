<template>
  <div class="kit-floating-tabbar">
    <div class="kit-floating-tabbar__gradient" />
    <div class="kit-floating-tabbar__pill">
      <!-- Leading slot: an optional affordance that mounts at the left of the
           pill (e.g. a contextual back button). Hosts control its own
           enter/leave transition; the pill (flex, width: fit-content)
           reshapes around it. -->
      <slot name="leading" />

      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="kit-floating-tabbar__tab"
        :class="{ 'kit-floating-tabbar__tab--active': tab.id === active }"
        :aria-label="tab.ariaLabel"
        :aria-current="tab.id === active ? 'page' : undefined"
        @click="onSelect(tab.id)"
      >
        <span class="kit-floating-tabbar__badge-wrapper">
          <!-- Per-tab icon. Scoped so hosts can morph the icon on active
               state (e.g. Globe ↔ Map) without leaving the kit. -->
          <slot name="icon" :tab="tab" :active="tab.id === active" />
        </span>
      </button>

      <!-- Optional primary CTA (the "review" button): a filled accent circle,
           visually distinct from the plain tabs. Rendered only when an
           `action-icon` slot is provided. -->
      <button
        v-if="$slots['action-icon']"
        type="button"
        class="kit-floating-tabbar__action"
        :class="{
          'kit-floating-tabbar__action--disabled': actionDisabled,
          'kit-floating-tabbar__action--pulse': actionPulse && !actionDisabled,
        }"
        :aria-label="actionAriaLabel"
        :aria-disabled="actionDisabled || undefined"
        @click="onAction"
      >
        <span class="kit-floating-tabbar__action-icon">
          <slot name="action-icon" />
        </span>
        <span v-if="$slots['action-badge']" class="kit-floating-tabbar__action-badge">
          <slot name="action-badge" />
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Floating bottom tab bar — a glassy pill that hovers over the bottom of the
 * screen with a gradient backdrop. Framework-agnostic: tabs are supplied via
 * the `tabs` prop, icons via a scoped `icon` slot (no icon set imported), the
 * active tab via `active` (`v-model` supported), and navigation is reported via
 * the `select` event (no router imported). A leading slot hosts an optional
 * contextual affordance (e.g. a back button) and the `action-icon` /
 * `action-badge` slots host an optional primary CTA that emits `action`.
 *
 * Appearance is 100% CSS-token-driven (`--kit-floating-tabbar-*`); the host
 * theme owns every brand colour, shadow and animation accent.
 */
export interface FloatingTab {
  /** Stable identifier reported by `select` and matched against `active`. */
  id: string
  /** Accessible label for the tab button. */
  ariaLabel?: string
}

defineProps<{
  /** The tabs to render, left to right. */
  tabs: FloatingTab[]
  /** Id of the currently-active tab (supports `v-model`). */
  active?: string
  /** Accessible label for the primary CTA button. */
  actionAriaLabel?: string
  /** Mute the CTA and suppress its click + pulse. */
  actionDisabled?: boolean
  /** Animate the CTA (breathe + spin) to advertise pending work. */
  actionPulse?: boolean
}>()

const emit = defineEmits<{
  /** A tab was tapped; payload is the tab id. */
  (e: "select", id: string): void
  /** `v-model:active` companion of `select`. */
  (e: "update:active", id: string): void
  /** The primary CTA was tapped (only when not disabled). */
  (e: "action"): void
}>()

function onSelect(id: string): void {
  emit("select", id)
  emit("update:active", id)
}

function onAction(): void {
  emit("action")
}
</script>

<style scoped>
.kit-floating-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  pointer-events: none;
}

/* Gradient backdrop so the pill doesn't float over unrelated scroll content. */
.kit-floating-tabbar__gradient {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 100%;
  background: var(--kit-floating-tabbar-gradient, none);
}

.kit-floating-tabbar__pill {
  position: relative;
  display: flex;
  align-items: center;
  width: fit-content;
  max-width: calc(100% - 40px);
  margin: 0 auto calc(env(safe-area-inset-bottom, 0px) + 8px);
  padding: 0 2px;
  height: 52px;
  border-radius: 28px;
  background: var(--kit-floating-tabbar-bg, var(--ion-color-light));
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  box-shadow: var(--kit-floating-tabbar-shadow, none);
  pointer-events: auto;
}

.kit-floating-tabbar__tab {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 100%;
  border: none;
  background: none;
  color: var(--kit-floating-tabbar-icon, var(--ion-color-medium));
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}

.kit-floating-tabbar__tab--active {
  color: var(--kit-floating-tabbar-icon-active, var(--ion-color-primary));
}

.kit-floating-tabbar__badge-wrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  transition: background 0.2s ease;
}

.kit-floating-tabbar__tab--active .kit-floating-tabbar__badge-wrapper {
  background: var(--kit-floating-tabbar-active-badge-bg, transparent);
}

/* Primary CTA — accent-filled circle; muted + no pointer when disabled. */
.kit-floating-tabbar__action {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 100%;
  border: none;
  background: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
  color: var(--kit-floating-tabbar-action-fg, var(--ion-color-primary-contrast));
}

.kit-floating-tabbar__action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--kit-floating-tabbar-action-bg, var(--ion-color-primary));
  box-shadow: var(--kit-floating-tabbar-action-shadow, none);
}

.kit-floating-tabbar__action--disabled {
  cursor: default;
}

.kit-floating-tabbar__action--disabled .kit-floating-tabbar__action-icon {
  background: var(--kit-floating-tabbar-action-disabled-bg, var(--ion-color-medium));
  box-shadow: none;
  opacity: 0.5;
}

.kit-floating-tabbar__action-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 2px 5px;
  font-size: 10px;
  line-height: 12px;
  border-radius: 8px;
  background: var(--kit-floating-tabbar-action-badge-bg, var(--ion-color-primary-shade));
  color: var(--kit-floating-tabbar-action-badge-fg, var(--ion-color-primary-contrast));
  box-shadow: var(--kit-floating-tabbar-action-badge-shadow, none);
  /* Stays put while the icon circle pulses (it lives outside that element). */
  transform: none;
}

/* CTA pulse — the accent circle breathes (scale + shadow) while its icon
 * spins, advertising that work is waiting. The root SVG of the slotted icon
 * picks up the scoped attribute, so no :deep is needed. */
@keyframes kit-floating-tabbar-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: var(--kit-floating-tabbar-action-shadow, none);
  }
  50% {
    transform: scale(1.12);
    box-shadow: var(
      --kit-floating-tabbar-action-pulse-shadow,
      var(--kit-floating-tabbar-action-shadow, none)
    );
  }
}

@keyframes kit-floating-tabbar-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(-360deg);
  }
}

.kit-floating-tabbar__action--pulse .kit-floating-tabbar__action-icon {
  animation: kit-floating-tabbar-pulse 2.4s ease-in-out infinite;
}

.kit-floating-tabbar__action--pulse .kit-floating-tabbar__action-icon > svg {
  animation: kit-floating-tabbar-spin 2.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .kit-floating-tabbar__action--pulse .kit-floating-tabbar__action-icon,
  .kit-floating-tabbar__action--pulse .kit-floating-tabbar__action-icon > svg {
    animation: none;
  }
}
</style>
