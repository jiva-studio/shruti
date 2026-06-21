<template>
  <div class="ob-paywall">
    <div class="ob-paywall__head">
      <h1 class="ob-paywall__title">{{ $t("onboarding.paywall.title") }}</h1>
      <p class="ob-paywall__subtitle">{{ $t("onboarding.paywall.subtitle") }}</p>
    </div>

    <!-- Real app screenshots show what Pro unlocks. Each hides itself if the
         asset isn't shipped yet, so the strip degrades gracefully. -->
    <div class="ob-paywall__shots">
      <img
        v-for="src in shots"
        v-show="!failed.has(src)"
        :key="src"
        :src="src"
        class="ob-paywall__shot"
        alt=""
        @error="failed.add(src)"
      />
    </div>

    <ul class="ob-paywall__bullets">
      <li>{{ $t("onboarding.paywall.b1") }}</li>
      <li>{{ $t("onboarding.paywall.b2") }}</li>
      <li>{{ $t("onboarding.paywall.b3") }}</li>
    </ul>

    <!-- Restore + legal links, moved up here out of the footer actions. -->
    <div class="ob-paywall__links">
      <a
        class="ob-paywall__link"
        role="button"
        tabindex="0"
        :class="{ 'is-busy': restoring }"
        @click="!restoring && emit('restore')"
        @keydown.enter="!restoring && emit('restore')"
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

<script setup lang="ts">
import { reactive } from "vue"
import type { LegalDocumentView } from "@ui/features/subscription/SubscriptionFooter.vue"

defineProps<{
  legalDocuments: LegalDocumentView[]
  restoring: boolean
}>()
const emit = defineEmits<{ restore: [] }>()

const shots = [
  "/onboarding/paywall-1.webp",
  "/onboarding/paywall-2.webp",
  "/onboarding/paywall-3.webp",
]
const failed = reactive(new Set<string>())
</script>

<style scoped>
.ob-paywall {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 16px 16px;
  box-sizing: border-box;
}
.ob-paywall__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
}
.ob-paywall__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.ob-paywall__subtitle {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-paywall__shots {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  justify-content: center;
  padding: 4px 0;
}
.ob-paywall__shot {
  height: clamp(160px, 26vh, 240px);
  width: auto;
  border-radius: 16px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}
.ob-paywall__bullets {
  margin: 0 auto;
  padding: 0 0 0 1.1em;
  max-width: 440px;
  color: var(--ion-text-color);
  font-size: 0.95rem;
  line-height: 1.7;
}
.ob-paywall__links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
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
