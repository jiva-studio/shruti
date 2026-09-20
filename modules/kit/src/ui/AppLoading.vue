<template>
  <IonPage>
    <IonContent :fullscreen="true" class="ion-padding">
      <div class="kit-app-loading">
        <div class="kit-app-loading-header">
          <slot name="icon">
            <img v-if="iconSrc" :src="iconSrc" alt="" class="kit-app-loading-logo" />
          </slot>
          <IonText color="primary">
            <h1 class="kit-app-loading-name">{{ appName }}</h1>
          </IonText>
        </div>

        <div class="kit-app-loading-status">
          <div v-if="!isError" class="kit-app-loading-progress">
            <IonProgressBar
              :type="isDeterminate ? 'determinate' : 'indeterminate'"
              :value="barValue"
            />
            <IonText color="medium">
              <p class="kit-app-loading-message">{{ status }}</p>
            </IonText>
          </div>
          <IonText v-else color="danger">
            <p class="kit-app-loading-message">{{ errorText }}</p>
          </IonText>
        </div>

        <div class="kit-app-loading-footer">
          <IonButton v-if="isError" expand="block" fill="solid" @click="emit('retry')">
            {{ retryLabel }}
          </IonButton>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IonPage, IonContent, IonText, IonButton, IonProgressBar } from "@ionic/vue"

/**
 * Generic first-launch / app-loading screen: app icon + app name + a status
 * line and optional progress bar, with an error + retry state. All text comes
 * via props (no i18n); the icon via a `prop` or the `icon` slot; navigation /
 * retry via the `retry` event (no router). Colours come from Ionic tokens —
 * no hardcoded brand values.
 */
const props = defineProps<{
  /** App name shown under the icon. */
  appName: string
  /** Status line, e.g. "Downloading content…". */
  status: string
  /** Optional icon image URL. Use the `icon` slot for richer markup. */
  iconSrc?: string
  /**
   * Download progress as a 0–1 fraction. When a finite number is given the
   * bar is determinate (fills to `progress`); when omitted / non-finite the
   * bar is indeterminate (animated). A bar is always shown in the non-error
   * state — that's the whole point of this screen.
   */
  progress?: number
  /** When set, the error state is shown instead of the progress bar. */
  errorText?: string | null
  /** Label for the retry button (error state only). */
  retryLabel?: string
}>()

const emit = defineEmits<{
  /** Emitted when the user taps Retry in the error state. */
  retry: []
}>()

const isError = computed(() => Boolean(props.errorText))
const retryLabel = computed(() => props.retryLabel ?? "Retry")

/**
 * Determinate only when a finite, positive progress fraction is supplied.
 * At 0 (download just started / total unknown) we stay indeterminate so the bar
 * animates and stays visible instead of rendering an empty determinate track.
 */
const isDeterminate = computed(
  () => typeof props.progress === "number" && Number.isFinite(props.progress) && props.progress > 0
)
/** Clamp to Ionic's 0–1 `value` range; 0 for the indeterminate case. */
const barValue = computed(() =>
  isDeterminate.value ? Math.min(1, Math.max(0, props.progress as number)) : 0
)
</script>

<style scoped>
.kit-app-loading {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.kit-app-loading-header {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 20px;
  gap: 16px;
}

.kit-app-loading-logo {
  width: var(--kit-app-loading-logo-size, 120px);
  height: var(--kit-app-loading-logo-size, 120px);
  border-radius: var(--kit-app-loading-logo-radius, 24px);
}

.kit-app-loading-name {
  font-size: var(--kit-app-loading-name-size, 32px);
  font-weight: bold;
  margin: 0;
}

.kit-app-loading-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
}

.kit-app-loading-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  width: 260px;
}

.kit-app-loading-message {
  margin: 0;
  font-size: 16px;
  text-align: center;
}

.kit-app-loading-progress ion-progress-bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
}

.kit-app-loading-footer {
  flex: 1;
  display: flex;
  align-items: flex-start;
  padding-top: 40px;
}

.kit-app-loading-footer ion-button {
  width: 100%;
  --box-shadow: none;
}
</style>
