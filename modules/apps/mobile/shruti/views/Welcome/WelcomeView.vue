<template>
  <!--
    Startup screen. The welcome UI (`showWelcomeScreen`) stays up for the whole
    startup — first-launch download/migration AND the cache-hit fast path while
    Home's data is pre-hydrated — until we actually navigate. The blank page
    below renders only during the crossfade out, so the user never stares at an
    empty background while content loads.
  -->
  <AppLoading
    v-if="welcome.showWelcomeScreen.value"
    :app-name="$t('app.name')"
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
