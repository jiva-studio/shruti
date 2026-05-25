<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.account") }}</IonLabel>
  </IonListHeader>

  <IonItem button :detail="false" lines="none" :disabled="busy" @click="onItemClick">
    <!-- Anonymous → neutral icon chip; signed-in → real avatar (image or
         initials fallback). The avatar replaces the chip so signed-in users
         get the personal touch. -->
    <IconChip v-if="anonymous" slot="start">
      <IconUserPlus />
    </IconChip>
    <!-- Signed-in avatar shares the square-rounded-corners chip shape with
         every other Settings row (see IconChip.vue / .settings-item-icon).
         IonAvatar's circular crop made the avatar pop out visually; this
         host is a plain div sized identically to the chip. The image fills
         it edge-to-edge with the same border-radius, and the initials
         fallback reuses the chip's neutral palette so a failed image looks
         like just another chip rather than a broken portrait. -->
    <div v-else slot="start" class="account-avatar settings-item-icon">
      <img
        v-if="picture && !pictureFailed"
        :src="picture"
        alt=""
        referrerpolicy="no-referrer"
        class="account-avatar__img"
        @error="pictureFailed = true"
      />
      <span v-else class="account-avatar__initials">{{ initials }}</span>
    </div>

    <IonLabel class="ion-text-wrap">
      <template v-if="anonymous">
        <h2>{{ $t("settings.account.signInCta.title") }}</h2>
        <p>{{ $t("settings.account.signInCta.description") }}</p>
      </template>
      <template v-else>
        <h2>{{ name || email || $t("settings.account.signedIn") }}</h2>
        <p>{{ $t("settings.account.signedIn") }}</p>
      </template>
    </IonLabel>
  </IonItem>

  <!-- Subscription row sits inside Account so the "who you are + what you've
       unlocked + where you fetch from" trio reads as one logical block.
       Always visible — including on builds without RC keys, where tapping
       it falls through to the paywall stack the same as any other Pro
       call-to-action. -->
  <IonItem
    v-if="isSubscribed"
    button
    :detail="true"
    lines="none"
    @click="emit('manage-subscription')"
  >
    <IconChip slot="start">
      <IconRosetteDiscountCheckFilled />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.subscription.subscriptionIsActive") }}</h2>
      <p>{{ $t("settings.subscription.tapToManage") }}</p>
    </IonLabel>
  </IonItem>

  <IonItem v-else button :detail="true" lines="none" @click="emit('open-paywall')">
    <IconChip slot="start">
      <IconRosetteDiscountCheckFilled />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.subscription.title") }}</h2>
      <p>{{ $t("settings.subscription.description") }}</p>
    </IonLabel>
  </IonItem>

  <ServerSettingsItem v-model="activeServerId" :items="serverItems" />

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

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { IconRosetteDiscountCheckFilled, IconUserPlus } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"
import ServerSettingsItem from "../ServerSettingsItem.vue"

interface SelectorItem {
  id: string
  title: string
}

const props = defineProps<{
  anonymous: boolean
  email: string | null
  name: string | null
  picture: string | null
  /** Capacitor platform — drives whether the Apple option shows up. */
  platform: "ios" | "android" | "web"
  isSubscribed: boolean
  serverItems: SelectorItem[]
}>()

const emit = defineEmits<{
  "sign-in-google": []
  "sign-in-apple": []
  "sign-out": []
  "open-paywall": []
  "manage-subscription": []
  "delete-account": [opts: { wipeLocal: boolean }]
}>()

const activeServerId = defineModel<string>("activeServerId", { required: true })

const { t } = useI18n()
const busy = ref(false)
const sheetOpen = ref(false)
const deleteSheetOpen = ref(false)
const pictureFailed = ref(false)

const initials = computed(() => {
  const source = props.name?.trim() || props.email?.trim() || ""
  if (!source) return "?"
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase()
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
})

const sheetButtons = computed(() => {
  if (props.anonymous) {
    // iOS surfaces Apple first by platform convention. Android skips the
    // sheet entirely — see onItemClick.
    const apple = { text: t("settings.account.signInWithApple"), handler: handleApple }
    const google = { text: t("settings.account.signInWithGoogle"), handler: handleGoogle }
    const cancel = { text: t("app.cancel"), role: "cancel" as const }
    return props.platform === "ios" ? [apple, google, cancel] : [google, cancel]
  }
  return [
    { text: t("settings.account.signOut"), role: "destructive" as const, handler: handleSignOut },
    {
      text: t("settings.account.deleteAccount.title"),
      role: "destructive" as const,
      handler: handleDeleteAccount,
    },
    { text: t("app.cancel"), role: "cancel" as const },
  ]
})

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
  // Only iOS has a real choice (Apple + Google). Android and web both
  // come down to Google-only — skip the one-option sheet and trigger it
  // directly. Same for the signed-in case there's no point either, but
  // logout always benefits from the confirm tap, so we keep the sheet
  // for signed-in regardless of platform.
  if (props.anonymous && props.platform !== "ios") {
    handleGoogle()
    return
  }
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

function handleGoogle(): void {
  withBusy(() => emit("sign-in-google"))
}
function handleApple(): void {
  withBusy(() => emit("sign-in-apple"))
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

<style scoped>
/* Match the size of every other Settings chip (IconChip + .settings-item-icon).
   The chip's own padding is meant for an SVG icon — override to 0 so the
   portrait fills the rounded square edge-to-edge. The .settings-item-icon
   class still supplies the background, border-radius and ion-item slot
   alignment, so the avatar lines up pixel-perfect with neighbouring rows. */
.account-avatar {
  width: 32px;
  height: 32px;
  padding: 0;
  overflow: hidden;
}
.account-avatar__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.account-avatar__initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-color-medium);
}
</style>
