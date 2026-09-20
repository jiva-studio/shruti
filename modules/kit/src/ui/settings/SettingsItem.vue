<template>
  <IonItem
    :button="button"
    :detail="detail"
    :disabled="disabled"
    :lines="lines"
    :class="{ 'kit-settings-item--danger': danger }"
    @click="onActivate"
  >
    <span v-if="$slots.icon" slot="start" class="kit-settings-item-icon">
      <slot name="icon" />
    </span>

    <IonLabel :class="wrap ? 'ion-text-wrap' : 'ion-text-nowrap'">
      <slot name="title">
        <h2 v-if="title">{{ title }}</h2>
      </slot>
      <slot name="subtitle">
        <p v-if="subtitle">{{ subtitle }}</p>
      </slot>
    </IonLabel>

    <span v-if="$slots.trailing" slot="end" class="kit-settings-item-trailing">
      <slot name="trailing" />
    </span>
  </IonItem>
</template>

<script setup lang="ts">
/**
 * Ionic settings-row shell built on `IonItem`/`IonLabel`: a leading icon slot
 * (rendered in the item's `start` slot), a title/subtitle text block, and a
 * trailing slot (`end` slot — for a toggle, value chip, or chooser).
 *
 * i18n-agnostic (text via props/slots), router-agnostic (interaction surfaces as
 * the `activate` event — the host decides where to navigate). Appearance comes
 * from Ionic's own item variables; `danger` recolours the title via
 * `--ion-color-danger`.
 *
 * Concrete item variants (toggle, select, time, action, account) compose this
 * shell; apps wire their own domain/i18n/state on top.
 */
import { IonItem, IonLabel } from "@ionic/vue"

withDefaults(
  defineProps<{
    /** Convenience for the default title slot (rendered as `<h2>`). */
    title?: string
    /** Convenience for the default subtitle slot (rendered as `<p>`). */
    subtitle?: string
    /** Render as an actionable row (Ionic ripple/press affordance). */
    button?: boolean
    /** Show Ionic's trailing chevron affordance. */
    detail?: boolean
    /** Disable interaction. */
    disabled?: boolean
    /** Apply the danger palette to the title. */
    danger?: boolean
    /** Wrap long label text instead of truncating. */
    wrap?: boolean
    /** Forwarded to `IonItem` — divider rendering. */
    lines?: "full" | "inset" | "none"
  }>(),
  { detail: false, lines: "none" }
)

const emit = defineEmits<{
  /** Fired on row click. The host decides whether/where to navigate. */
  activate: []
}>()

function onActivate(): void {
  emit("activate")
}
</script>

<style scoped>
.kit-settings-item-icon {
  display: inline-flex;
  align-items: center;
}

.kit-settings-item-trailing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.kit-settings-item--danger :deep(h2) {
  color: var(--kit-settings-item-danger-fg, var(--ion-color-danger));
}
</style>
