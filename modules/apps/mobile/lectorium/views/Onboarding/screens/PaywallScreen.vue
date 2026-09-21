<script setup lang="ts">
import { SubscriptionShots } from "@ui/features/subscription/index.js"
import type { LegalDocumentView } from "@ui/features/subscription/index.js"
import { usePaywallShots } from "@lectorium/composables/usePaywallShots.js"

const props = defineProps<{
  legalDocuments: LegalDocumentView[]
  restoring: boolean
}>()
const emit = defineEmits<{ restore: [] }>()

const shots = usePaywallShots()

function onRestore(): void {
  if (props.restoring) return
  emit("restore")
}
</script>

<template>
  <div class="ob-paywall">
    <div class="ob-paywall__head">
      <h1 class="ob-paywall__title">{{ $t("onboarding.paywall.title") }}</h1>
      <p class="ob-paywall__subtitle">{{ $t("onboarding.paywall.subtitle") }}</p>
    </div>

    <SubscriptionShots class="ob-paywall__shots" :shots="shots" />

    <!-- Restore + legal links, moved up here out of the footer actions. -->
    <div class="ob-paywall__links">
      <a
        class="ob-paywall__link"
        role="button"
        tabindex="0"
        :class="{ 'is-busy': restoring }"
        @click="onRestore"
        @keydown.enter="onRestore"
      >
        {{ $t("settings.subscription.restore") }}
      </a>
      <a
        v-for="doc in legalDocuments"
        :key="doc.title"
        class="ob-paywall__link"
        :href="doc.link"
        target="_blank"
      >
        {{ doc.title }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.ob-paywall {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Fill the slide so the legal links can sit at the bottom, near the footer
     buttons, instead of floating mid-screen. */
  min-height: 100%;
  padding: 8px 16px 12px;
  box-sizing: border-box;
}
.ob-paywall__head {
  text-align: center;
  max-width: 440px;
  /* auto top + auto bottom (on .ob-paywall__shots) centre the title+shots in
     the space above the links, matching the other centred screens. */
  margin: auto auto 0;
}
.ob-paywall__title {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.ob-paywall__subtitle {
  margin: 8px 0 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-paywall__shots {
  /* Bottom auto pairs with the head's top auto to vertically centre the
     title+shots group above the links. */
  margin-bottom: auto;
}
.ob-paywall__links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0;
  padding-top: 8px;
}
/* A centred dot between the links so Restore · Privacy reads as one line. */
.ob-paywall__link + .ob-paywall__link::before {
  content: "·";
  margin-inline: 0.55em;
  color: var(--ion-color-medium);
}
.ob-paywall__link {
  color: var(--ion-color-medium);
  font-size: 0.9rem;
  cursor: pointer;
  text-decoration: none;
}
.ob-paywall__link.is-busy {
  opacity: 0.5;
  pointer-events: none;
}
</style>
