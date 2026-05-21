<template>
  <div class="status-pill" role="status" aria-live="polite">
    <IonSpinner class="spinner" name="dots" aria-hidden="true" />
    <span v-if="label" class="label">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"

const props = defineProps<{
  /** i18n key under `chat.status.<key>`. The server emits these via
   *  the `status` SSE event (v1) — e.g. `searching_corpus`,
   *  `composing_answer`. Omitted before the first status arrives;
   *  the pill still renders, showing only the bouncing dots until
   *  a key shows up. Unknown keys fall back to the generic "thinking"
   *  label so a server feature-drop doesn't blank the pill mid-turn. */
  statusKey?: string
  params?: Readonly<Record<string, string | number>>
}>()

const { t, te } = useI18n()

const label = computed(() => {
  const key = props.statusKey
  if (!key) return ""
  const path = `chat.status.${key}`
  if (te(path)) return t(path, (props.params ?? {}) as Record<string, unknown>)
  return t("chat.status.thinking")
})
</script>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--ion-color-step-50, rgba(0, 0, 0, 0.04));
  color: var(--ion-color-medium, #6b7280);
  font-size: 13px;
  line-height: 1;
}
/* Same `IonSpinner name="dots"` used on the send button — calm pulse,
 * no vertical bounce. Sized down so it sits inside the pill cleanly. */
.spinner {
  width: 18px;
  height: 18px;
  color: currentColor;
}
.label {
  white-space: nowrap;
}
</style>
