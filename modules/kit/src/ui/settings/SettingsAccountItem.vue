<template>
  <SettingsItem
    :title="primary"
    :subtitle="secondary"
    :disabled="disabled"
    :detail="detail"
    button
    @activate="onActivate"
  >
    <template #icon>
      <slot name="avatar">
        <span class="kit-settings-account-avatar">
          <span v-if="initials" class="kit-settings-account-initials">{{ initials }}</span>
        </span>
      </slot>
    </template>
    <template #title><slot name="title" /></template>
    <template #subtitle><slot name="subtitle" /></template>
    <template v-if="$slots.trailing" #trailing><slot name="trailing" /></template>
  </SettingsItem>
</template>

<script setup lang="ts">
/**
 * Settings row representing the current account / sign-in state. The host passes
 * already-resolved display text:
 *  - signed out: `signedIn=false` → show a "sign in" call-to-action via `title`/
 *    `subtitle` (host-translated).
 *  - signed in: `name`/`email` + a `signedIn` subtitle.
 *
 * `name`/`email` drive a default initials avatar; supply the `avatar` slot for a
 * real picture. Tapping emits `activate` — the host opens its own sign-in /
 * account sheet. i18n-agnostic, no auth store, no router.
 */
import { computed } from "vue"
import SettingsItem from "./SettingsItem.vue"

const props = defineProps<{
  /** Whether the user is signed in (selects which text the host should pass). */
  signedIn?: boolean
  /** Display name (signed-in primary line / initials source). */
  name?: string
  /** Email (fallback primary line / initials source). */
  email?: string
  /** Convenience title — overrides name/email for the primary line. */
  title?: string
  /** Convenience subtitle for the secondary line. */
  subtitle?: string
  /** Disable the row. */
  disabled?: boolean
  /** Show Ionic's trailing chevron. */
  detail?: boolean
}>()

const emit = defineEmits<{
  /** The row was tapped — host opens sign-in / account actions. */
  activate: []
}>()

const primary = computed<string | undefined>(() => props.title ?? props.name ?? props.email)
const secondary = computed<string | undefined>(() => props.subtitle)

const initials = computed<string>(() => {
  const source = (props.name?.trim() || props.email?.trim()) ?? ""
  if (!source) return ""
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase()
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
})

function onActivate(): void {
  emit("activate")
}
</script>

<style scoped>
.kit-settings-account-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--kit-settings-account-avatar-bg, var(--ion-color-light-shade));
}

.kit-settings-account-initials {
  font-size: 13px;
  font-weight: 600;
  color: var(--kit-settings-account-avatar-fg, var(--ion-color-medium));
}
</style>
