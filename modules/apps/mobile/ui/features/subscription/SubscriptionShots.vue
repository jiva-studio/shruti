<template>
  <!-- A horizontally scrolling strip of phone-top screenshots (rounded,
       top-cropped) so each feature's screen and its caption are both visible.
       Each figure hides itself if its asset isn't shipped, so the strip
       degrades gracefully. Shared by the onboarding paywall and the Settings
       subscription page. -->
  <div ref="strip" class="shots">
    <figure
      v-for="s in shots"
      v-show="!failed.has(s.key)"
      :key="s.key"
      :data-key="s.key"
      class="shot"
    >
      <img :src="s.src" class="shot__img" alt="" @error="failed.add(s.key)" />
      <figcaption class="shot__cap">
        <span class="shot__caption">{{ s.label }}</span>
        <span class="shot__desc">{{ s.desc }}</span>
      </figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from "vue"

export interface ShotView {
  key: string
  label: string
  desc: string
  src: string
}

const props = defineProps<{
  shots: ReadonlyArray<ShotView>
  /** Scroll this shot to the centre on mount — used by the paywall's
   *  `?feature=` deep link so a locked setting lands on its slide. */
  initialKey?: string
}>()

const strip = ref<HTMLElement | null>(null)
const failed = reactive(new Set<string>())

onMounted(async () => {
  if (!props.initialKey) return
  await nextTick()
  const target = strip.value?.querySelector<HTMLElement>(`[data-key="${props.initialKey}"]`)
  target?.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" })
})
</script>

<style scoped>
.shots {
  --shot-card-w: clamp(240px, 74vw, 320px);
  display: flex;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-padding-inline: 16px;
  margin-inline: -16px;
  padding-block: 4px 2px;
  padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.shots::-webkit-scrollbar {
  display: none;
}
.shot {
  flex: 0 0 auto;
  width: var(--shot-card-w);
  margin: 0;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.shot__img {
  width: 100%;
  /* Top-crop: show the head of each screen, the rest cut off. */
  height: clamp(200px, 32vh, 300px);
  object-fit: cover;
  object-position: top center;
  border-radius: 12px;
  border: 1px solid var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
}
.shot__cap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  text-align: center;
}
.shot__caption {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.shot__desc {
  font-size: 0.78rem;
  line-height: 1.35;
  color: var(--ion-color-medium);
  /* Cap captions at two lines so a long (or long-in-translation) description
     can't push the strip taller than the screenshots. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
