<template>
  <div class="ob-paywall">
    <div class="ob-paywall__head">
      <h1 class="ob-paywall__title">{{ $t("onboarding.paywall.title") }}</h1>
    </div>

    <!-- Real app screenshots show what Pro unlocks: a horizontally scrolling
         strip of phone tops (rounded, top-cropped) so the description and the
         top of each screen are both visible. Each hides itself if its asset
         isn't shipped, so the strip degrades gracefully. -->
    <div class="ob-paywall__shots">
      <figure v-for="s in shots" v-show="!failed.has(s.key)" :key="s.key" class="ob-paywall__shot">
        <img :src="src(s.key)" class="ob-paywall__img" alt="" @error="failed.add(s.key)" />
        <figcaption class="ob-paywall__cap">
          <span class="ob-paywall__caption">{{ $t(s.labelKey) }}</span>
          <span class="ob-paywall__desc">{{ $t(s.descKey) }}</span>
        </figcaption>
      </figure>
    </div>

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
import { computed, reactive } from "vue"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import type { LegalDocumentView } from "@ui/features/subscription/index.js"

defineProps<{
  legalDocuments: LegalDocumentView[]
  restoring: boolean
}>()
const emit = defineEmits<{ restore: [] }>()

const appLanguage = useAppLanguage()
// Screenshots exist in en + ru; everything else falls back to en.
const shotLang = computed(() => (appLanguage.value === "ru" ? "ru" : "en"))

const shots = [
  {
    key: "chat",
    labelKey: "onboarding.paywall.shots.chat",
    descKey: "onboarding.paywall.shotDesc.chat",
  },
  {
    key: "library",
    labelKey: "onboarding.paywall.shots.library",
    descKey: "onboarding.paywall.shotDesc.library",
  },
  {
    key: "transcript",
    labelKey: "onboarding.paywall.shots.transcript",
    descKey: "onboarding.paywall.shotDesc.transcript",
  },
  {
    key: "notes",
    labelKey: "onboarding.paywall.shots.notes",
    descKey: "onboarding.paywall.shotDesc.notes",
  },
  {
    key: "home",
    labelKey: "onboarding.paywall.shots.home",
    descKey: "onboarding.paywall.shotDesc.home",
  },
] as const

const src = (key: string): string => `/onboarding/${shotLang.value}/${key}.webp`
const failed = reactive(new Set<string>())
</script>

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
.ob-paywall__shots {
  --ob-card-w: clamp(240px, 74vw, 320px);
  display: flex;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  /* Full-bleed: cancel the paywall's side padding so cards scroll to (and off)
     the screen edges instead of being clipped 16px in. */
  margin-inline: -16px;
  /* Bottom auto pairs with the head's top auto to vertically centre the
     title+shots group above the links. */
  margin-bottom: auto;
  /* Side inset = half the leftover width, so the FIRST (and last) card can sit
     dead-centre at the scroll extremes — without it, mandatory snap can't
     centre the first card and jumps to a middle one. */
  padding-block: 4px 2px;
  padding-inline: max(16px, calc((100% - var(--ob-card-w)) / 2));
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ob-paywall__shots::-webkit-scrollbar {
  display: none;
}
.ob-paywall__shot {
  flex: 0 0 auto;
  width: var(--ob-card-w);
  margin: 0;
  scroll-snap-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.ob-paywall__img {
  width: 100%;
  /* Top-crop: show the head of each screen, the rest cut off. */
  height: clamp(200px, 32vh, 300px);
  object-fit: cover;
  object-position: top center;
  border-radius: 12px;
  border: 1px solid var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
}
.ob-paywall__cap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  text-align: center;
}
.ob-paywall__caption {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-paywall__desc {
  font-size: 0.78rem;
  line-height: 1.35;
  color: var(--ion-color-medium);
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
