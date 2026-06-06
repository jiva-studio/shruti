<template>
  <!--
    Startup screen. With the Stale-While-Revalidate flow, the welcome UI is
    shown ONLY on a first launch / when no usable local content DB exists
    (`showWelcomeScreen`). When a compatible local DB is present we open it and
    navigate to the app immediately — this view renders a blank page for the
    brief moment before the redirect, so no welcome screen flashes.
  -->
  <AppLoading
    v-if="welcome.showWelcomeScreen.value"
    :app-name="$t('app.title')"
    icon-src="/app-icon.png"
    :status="statusMessage"
    :progress="welcome.phase.value === 'welcome:downloading' ? welcome.progress.value : undefined"
    :error-text="welcome.isError.value ? welcome.error.value : null"
    :retry-label="$t('welcome.retry')"
    @retry="welcome.onRetry"
  />
  <IonPage v-else />
</template>

<script setup lang="ts">
import { IonPage } from "@ionic/vue"
import { AppLoading } from "@kit/ui"
import { useWelcomeController } from "./WelcomeView.controller.js"
import { useStatusMessage } from "./composables/useStatusMessage.js"

const welcome = useWelcomeController()
const statusMessage = useStatusMessage(welcome.phase)
</script>
