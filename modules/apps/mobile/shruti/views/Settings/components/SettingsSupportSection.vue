<script setup lang="ts">
import { ref } from "vue"
import { Clipboard } from "@capacitor/clipboard"
import { useI18n } from "vue-i18n"
import {
  LogsDialog,
  SettingsContactsGroup,
  SettingsDebugGroup,
  SettingsHelpGroup,
} from "@ui/features/settings/index.js"
import { HelpDialog } from "@ui/features/help/index.js"
import { useShruti } from "@shruti/shruti.js"
import { privacyPolicyUrl } from "@shruti/i18n/index.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { useLogsStore } from "@shruti/stores/useLogsStore.js"
import { useToast } from "@kit/composables"
import { useSubscriptionBinding } from "../composables/useSubscriptionBinding.js"
import { buildDiagnosticsBody, mailtoUrl } from "../diagnosticsEmail.js"

// Help, contact links and the developer-only diagnostics. Capacitor's webview
// hands `mailto:` and `_system` links to the OS; the in-app webview must not
// try to navigate to them itself.
const props = defineProps<{ version: string; buildId: string; debugUnlocked: boolean }>()

const emit = defineEmits<{ "clear-cache": [] }>()

const SUPPORT_EMAIL = "support@jiva.studio"

const i18n = useI18n()
const { t } = i18n
const app = useShruti()
const auth = useAuthStore()
const logs = useLogsStore()
const toast = useToast()
const subscription = useSubscriptionBinding()

const helpOpen = ref(false)
const logsOpen = ref(false)

function onOpenPrivacyPolicy(): void {
  window.open(privacyPolicyUrl(i18n.locale.value as string), "_blank")
}

function onOpenStudio(): void {
  window.open("https://jiva.studio", "_system")
}

function onOpenVk(): void {
  window.open("https://vk.com/akd.studio", "_system")
}

function onOpenTelegram(): void {
  window.open("https://t.me/shrutiapp", "_system")
}

// The plain support email carries a subject and an intro, nothing else.
function onOpenEmail(): void {
  const subject = t("settings.contacts.email.emailSubject")
  const body = t("settings.contacts.email.emailIntro")
  window.open(mailtoUrl(SUPPORT_EMAIL, subject, body), "_system")
}

async function supportDeviceId(): Promise<string> {
  try {
    const { Device } = await import("@capacitor/device")
    return (await Device.getId()).identifier
  } catch {
    return "—"
  }
}

async function supportAppVersion(): Promise<string> {
  try {
    const { App } = await import("@capacitor/app")
    const info = await App.getInfo()
    return `${info.version} (${info.build})`
  } catch {
    // Web build has no native App plugin; fall back to the bundled version.
    return `${props.version} (${props.buildId})`
  }
}

async function onOpenDiagnosticsEmail(): Promise<void> {
  const body = buildDiagnosticsBody(
    t("settings.debug.email.emailIntro"),
    {
      userId: auth.userId,
      email: auth.email,
      tier: auth.tier,
      isPro: auth.isPro,
      appUserId: subscription.appUserId ?? null,
      deviceId: await supportDeviceId(),
      platform: app.platform,
      appVersion: await supportAppVersion(),
      locale: i18n.locale.value as string,
    },
    logs.asText()
  )
  window.open(mailtoUrl(SUPPORT_EMAIL, t("settings.debug.email.emailSubject"), body), "_system")
}

async function onCopyLogs(): Promise<void> {
  try {
    await Clipboard.write({ string: logs.asText() })
    await toast.info(t("settings.logs.copied"))
  } catch (e) {
    console.warn("[settings] copy logs failed:", e)
  }
}
</script>

<template>
  <SettingsHelpGroup @open-help="helpOpen = true" @open-privacy-policy="onOpenPrivacyPolicy" />

  <SettingsContactsGroup
    @open-studio="onOpenStudio"
    @open-email="onOpenEmail"
    @open-vk="onOpenVk"
    @open-telegram="onOpenTelegram"
  />

  <SettingsDebugGroup
    v-if="debugUnlocked"
    :count="logs.count"
    @view-logs="logsOpen = true"
    @email-diagnostics="onOpenDiagnosticsEmail"
    @clear-cache="emit('clear-cache')"
  />

  <HelpDialog v-model:open="helpOpen" />

  <LogsDialog
    v-model:open="logsOpen"
    :entries="logs.entries"
    :count="logs.count"
    @copy="onCopyLogs"
    @clear="logs.clear"
  />
</template>
