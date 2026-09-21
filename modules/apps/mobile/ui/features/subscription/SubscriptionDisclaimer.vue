<script setup lang="ts">
import { IonNote } from "@ionic/vue"

/** The trial/renewal small print shown under the plans. A host composes it
 *  only where required (Settings); onboarding omits it. */
defineProps<{ hasTrial: boolean }>()
</script>

<template>
  <IonNote class="trial-disclaimer">
    {{
      hasTrial
        ? $t("settings.subscription.trialDisclaimer")
        : $t("settings.subscription.disclaimer")
    }}
  </IonNote>
</template>

<style scoped>
.trial-disclaimer {
  display: block;
  max-width: 320px;
  margin: 14px auto 4px;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--ion-color-medium);
  text-align: center;
}
</style>
