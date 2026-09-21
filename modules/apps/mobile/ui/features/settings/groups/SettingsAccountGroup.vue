<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { IconCrownFilled } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"
import ServerSettingsItem from "../ServerSettingsItem.vue"
import SettingsAccountRow from "../SettingsAccountRow.vue"

interface SelectorItem {
  id: string
  title: string
}

const props = defineProps<{
  anonymous: boolean
  email: string | null
  name: string | null
  picture: string | null
  isSubscribed: boolean
  /** `ready && !reconciling` on the purchases store — see the sell row. */
  subscriptionResolved: boolean
  serverItems: SelectorItem[]
  /** Currently-preferred server id. Read-only from this component's
   *  perspective — changes flow through `preferred-server-change`. */
  activeServerId: string
}>()

const emit = defineEmits<{
  /**
   * Anonymous user tapped the row. Parent (composition root) routes
   * this through the shared `useAnonymousSignInFlow` composable so the
   * chat limit banner and this row hit the exact same provider flow.
   */
  "sign-in-anonymous": []
  "sign-out": []
  "open-paywall": []
  "manage-subscription": []
  "delete-account": [opts: { wipeLocal: boolean }]
  /** User picked a new preferred server. Parent flips `activeServer`;
   *  the HTTP client handles failover transparently from then on. */
  "preferred-server-change": [newServerId: string]
}>()

const activeServerIdProxy = computed<string>({
  get: () => props.activeServerId,
  set: (next) => {
    if (next === props.activeServerId) return
    emit("preferred-server-change", next)
  },
})

const { t } = useI18n()
const busy = ref(false)
const sheetOpen = ref(false)
const deleteSheetOpen = ref(false)

// Signed-in-only sheet. The anonymous branch presents its own sheet
// imperatively via the composable.
const sheetButtons = computed(() => [
  { text: t("settings.account.signOut"), role: "destructive" as const, handler: handleSignOut },
  {
    text: t("settings.account.deleteAccount.title"),
    role: "destructive" as const,
    handler: handleDeleteAccount,
  },
  { text: t("app.cancel"), role: "cancel" as const },
])

// Both delete options are irreversible, so both get the destructive role —
// Ionic paints both red, which matches their weight. withBusy() gates the
// emit so a laggy network can't be double-tapped into two server-side
// deletes (see useAuthStore.deleteAccount → /account/delete).
const deleteSheetButtons = computed(() => [
  {
    text: t("settings.account.deleteAccount.confirmWipe"),
    role: "destructive" as const,
    handler: () => withBusy(() => emit("delete-account", { wipeLocal: true })),
  },
  {
    text: t("settings.account.deleteAccount.confirmKeep"),
    role: "destructive" as const,
    handler: () => withBusy(() => emit("delete-account", { wipeLocal: false })),
  },
  { text: t("app.cancel"), role: "cancel" as const },
])

function onItemClick(): void {
  if (busy.value) return
  if (props.anonymous) {
    withBusy(() => emit("sign-in-anonymous"))
    return
  }
  // Signed-in users always see the sheet (sign-out / delete confirm).
  sheetOpen.value = true
}

function withBusy(fn: () => void): void {
  if (busy.value) return
  busy.value = true
  try {
    fn()
  } finally {
    busy.value = false
  }
}

function handleSignOut(): void {
  withBusy(() => emit("sign-out"))
}
function handleDeleteAccount(): void {
  // Hop straight from the first sheet to the confirm sheet — no
  // intermediate state, no busy gate; the second sheet is itself the
  // confirmation step.
  deleteSheetOpen.value = true
}
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.account") }}</IonLabel>
  </IonListHeader>

  <SettingsAccountRow
    :anonymous="anonymous"
    :email="email"
    :name="name"
    :picture="picture"
    :disabled="busy"
    @activate="onItemClick"
  />

  <!-- Subscription row sits inside Account so the "who you are + what you've
       unlocked + where you fetch from" trio reads as one logical block.
       Always visible — including on builds without RC keys, where tapping
       it falls through to the paywall stack the same as any other Pro
       call-to-action. -->
  <SettingsActionItem
    v-if="isSubscribed"
    detail
    :title="$t('settings.subscription.subscriptionIsActive')"
    :subtitle="$t('settings.subscription.tapToManage')"
    @activate="emit('manage-subscription')"
  >
    <template #icon>
      <IconChip><IconCrownFilled /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- The sell row waits for the FINAL subscribed answer. `isSubscribed`
       is false for the length of the post-sign-in RC.logIn, so gating the
       row on it alone offered a subscription to someone who already pays
       (#1797). Held back for that beat rather than shown wrong. -->
  <SettingsActionItem
    v-else-if="subscriptionResolved"
    detail
    :title="$t('settings.subscription.title')"
    :subtitle="$t('settings.subscription.description')"
    @activate="emit('open-paywall')"
  >
    <template #icon>
      <IconChip><IconCrownFilled /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- Neither answer yet. Rendering nothing made the row vanish from the
       list on every cold start — a gap with no skeleton and no explanation,
       which reads as "this device has no subscription section" (#1838).
       Hold the slot with a disabled row instead. -->
  <SettingsActionItem
    v-else
    disabled
    :title="$t('settings.subscription.title')"
    :subtitle="$t('settings.subscription.loading')"
  >
    <template #icon>
      <IconChip><IconCrownFilled /></IconChip>
    </template>
  </SettingsActionItem>

  <ServerSettingsItem v-model="activeServerIdProxy" :items="serverItems" />

  <IonActionSheet :is-open="sheetOpen" :buttons="sheetButtons" @did-dismiss="sheetOpen = false" />

  <!-- Second sheet asks WHICH delete (wipe device data or keep it) before
       we emit upward. Kept as an action sheet for visual parity with the
       sign-out / sign-in sheet above — no header, no body text. -->
  <IonActionSheet
    :is-open="deleteSheetOpen"
    :buttons="deleteSheetButtons"
    @did-dismiss="deleteSheetOpen = false"
  />
</template>
