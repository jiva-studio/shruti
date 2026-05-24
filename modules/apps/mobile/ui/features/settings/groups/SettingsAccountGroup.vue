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
    <IonAvatar v-else slot="start" class="account-avatar">
      <img v-if="picture && !pictureFailed" :src="picture" @error="pictureFailed = true" />
      <div v-else class="account-avatar__initials">{{ initials }}</div>
    </IonAvatar>

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
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonAvatar, IonItem, IonLabel, IonListHeader } from "@ionic/vue"
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
}>()

const activeServerId = defineModel<string>("activeServerId", { required: true })

const { t } = useI18n()
const busy = ref(false)
const sheetOpen = ref(false)
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
    { text: t("app.cancel"), role: "cancel" as const },
  ]
})

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
</script>

<style scoped>
.account-avatar {
  width: 32px;
  height: 32px;
  margin-inline-end: 16px;
  /* ion-avatar's host sets border-radius:50% but no overflow clip — the
     initials <div> fallback (not an <img>) leaks past the rounded corners
     and renders square. */
  overflow: hidden;
}
.account-avatar__initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--ion-color-step-200, #eee);
  color: var(--ion-color-step-700, #555);
  font-size: 13px;
  font-weight: 600;
}
</style>
