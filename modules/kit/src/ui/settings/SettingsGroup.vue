<template>
  <IonListHeader v-if="$slots.header || title">
    <slot name="header">
      <IonLabel>{{ title }}</IonLabel>
    </slot>
  </IonListHeader>

  <IonList :inset="inset" :lines="lines">
    <slot />
  </IonList>

  <div v-if="$slots.footer || footer" class="kit-settings-group-footer">
    <slot name="footer">{{ footer }}</slot>
  </div>
</template>

<script setup lang="ts">
/**
 * Ionic settings-group shell: an optional `IonListHeader` (group title) above an
 * `IonList` that holds the rows (default slot, typically SettingsItem variants),
 * plus an optional footer/help line.
 *
 * i18n-agnostic (title/footer come via props or slots, already translated),
 * router-agnostic (rows emit their own events), themeable via Ionic's own
 * variables plus the additive `--kit-settings-group-footer-*` tokens.
 */
import { IonList, IonListHeader, IonLabel } from "@ionic/vue"

withDefaults(
  defineProps<{
    /** Convenience for the default header slot — already-translated text. */
    title?: string
    /** Convenience for the default footer slot — already-translated text. */
    footer?: string
    /** Render the list as an inset card (iOS-style grouped settings). */
    inset?: boolean
    /** Forwarded to `IonList` — divider rendering between rows. */
    lines?: "full" | "inset" | "none"
  }>(),
  { inset: false, lines: "none" }
)
</script>

<style scoped>
.kit-settings-group-footer {
  padding: var(--kit-settings-group-footer-padding, 8px 16px 16px);
  font-size: 0.8em;
  color: var(--kit-settings-group-footer-fg, var(--ion-color-medium));
}
</style>
