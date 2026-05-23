<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.account") }}</IonLabel>
  </IonListHeader>

  <template v-if="anonymous">
    <IonItem lines="none">
      <IconChip slot="start">
        <IconUserPlus />
      </IconChip>
      <IonLabel class="ion-text-wrap">
        <h2>{{ $t("settings.account.signInCta.title") }}</h2>
        <p>{{ $t("settings.account.signInCta.description") }}</p>
      </IonLabel>
    </IonItem>

    <IonItem button :detail="false" lines="none" :disabled="busy" @click="onGoogle">
      <IconChip slot="start">
        <IconBrandGoogle />
      </IconChip>
      <IonLabel>{{ $t("settings.account.signInWithGoogle") }}</IonLabel>
    </IonItem>

    <!-- Apple Sign-In is iOS-only. On Android Apple's flow requires a Service ID
         + .p8 key + a server OAuth callback with deep-link routing — not worth
         the effort given Android users overwhelmingly go through Google. -->
    <IonItem
      v-if="platform !== 'android'"
      button
      :detail="false"
      lines="none"
      :disabled="busy"
      @click="onApple"
    >
      <IconChip slot="start">
        <IconBrandApple />
      </IconChip>
      <IonLabel>{{ $t("settings.account.signInWithApple") }}</IonLabel>
    </IonItem>
  </template>

  <template v-else>
    <IonItem lines="none">
      <IconChip slot="start">
        <IconUser />
      </IconChip>
      <IonLabel class="ion-text-wrap">
        <h2>{{ name || email || $t("settings.account.signedIn") }}</h2>
        <p v-if="name && email">{{ email }}</p>
      </IonLabel>
    </IonItem>

    <IonItem button :detail="false" lines="none" :disabled="busy" @click="onSignOut">
      <IconChip slot="start">
        <IconLogout />
      </IconChip>
      <IonLabel>{{ $t("settings.account.signOut") }}</IonLabel>
    </IonItem>
  </template>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import {
  IconBrandApple,
  IconBrandGoogle,
  IconLogout,
  IconUser,
  IconUserPlus,
} from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{
  anonymous: boolean
  email: string | null
  name: string | null
  /** Capacitor platform — drives whether the Apple button shows up. */
  platform: "ios" | "android" | "web"
}>()

const emit = defineEmits<{
  "sign-in-google": []
  "sign-in-apple": []
  "sign-out": []
}>()

const busy = ref(false)

async function withBusy(fn: () => void): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    fn()
  } finally {
    busy.value = false
  }
}

function onGoogle() {
  void withBusy(() => emit("sign-in-google"))
}
function onApple() {
  void withBusy(() => emit("sign-in-apple"))
}
function onSignOut() {
  void withBusy(() => emit("sign-out"))
}
</script>
