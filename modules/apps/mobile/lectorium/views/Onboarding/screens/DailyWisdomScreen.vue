<template>
  <div class="ob-wisdom">
    <div class="ob-wisdom__head">
      <h1 class="ob-wisdom__title">{{ $t("onboarding.wisdom.title") }}</h1>
      <p class="ob-wisdom__subtitle">{{ $t("onboarding.wisdom.subtitle") }}</p>
    </div>

    <!-- A real example of what arrives: the same playable citation card chat
         uses (player on top, transcript below), for a fragment matched to the
         user's topics in their library language. -->
    <div v-if="wisdom" class="ob-wisdom__card">
      <CitationCard
        :track-id="wisdom.trackId"
        :start-ms="wisdom.startMs"
        :end-ms="wisdom.endMs"
        :caption="wisdom.text"
        :body="{ text: wisdom.text }"
      />
    </div>

    <div class="ob-wisdom__presets" role="radiogroup">
      <ToggleChip
        role="radio"
        :selected="!enabled"
        data-testid="onboarding-wisdom-off"
        @toggle="emit('update:enabled', false)"
      >
        {{ $t("onboarding.wisdom.off") }}
      </ToggleChip>
      <ToggleChip
        v-for="p in presets"
        :key="p.key"
        role="radio"
        :selected="enabled && time[0] === p.hour"
        @toggle="selectTime(p.hour)"
      >
        {{ $t(p.labelKey) }}
      </ToggleChip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { ToggleChip } from "@ui/primitives/index.js"
import CitationCard from "@lectorium/views/Chat/components/CitationCard.vue"
import type { DailyWisdom } from "@lib/domain/dailyWisdom.js"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"

const props = defineProps<{
  enabled: boolean
  time: [number, number]
  topicIds: readonly string[]
  active?: boolean
}>()

const emit = defineEmits<{
  (e: "update:enabled", value: boolean): void
  (e: "update:time", value: [number, number]): void
}>()

const app = useLectorium()
const libraryLanguages = useLibraryLanguages()
const wisdom = ref<DailyWisdom | null>(null)

function selectTime(hour: number): void {
  emit("update:time", [hour, 0])
  if (!props.enabled) emit("update:enabled", true)
}

function pickRandom<T>(arr: readonly T[]): T | null {
  return arr.length === 0 ? null : arr[Math.floor(Math.random() * arr.length)]
}

// One fragment for the preview: prefer the user's picked topics, then fall back
// to any fragment. Each step walks the library languages (then en/ru) so the
// example reads in a language the user has content in — the same fallback chain
// the value screen uses for lectures.
async function loadPreview(): Promise<void> {
  if (wisdom.value) return
  const repos = app.repositories()
  const langs = [...new Set([...libraryLanguages.value, "en", "ru"])] as LanguageCode[]
  const topics = props.topicIds as readonly TopicId[]

  for (const lang of langs) {
    const topic = pickRandom(await repos.dailyWisdom.topicsWithWisdom(topics, lang))
    if (!topic) continue
    const w = pickRandom(await repos.dailyWisdom.byTopic(topic, lang))
    if (w) return void (wisdom.value = w)
  }
  for (const lang of langs) {
    const w = pickRandom(await repos.dailyWisdom.list(lang))
    if (w) return void (wisdom.value = w)
  }
  wisdom.value = pickRandom(await repos.dailyWisdom.list())
}

watch(
  () => props.active,
  (a) => {
    if (a) void loadPreview().catch(() => undefined)
  },
  { immediate: true }
)

const presets = [
  { key: "morning", hour: 9, labelKey: "onboarding.wisdom.morning" as const },
  { key: "afternoon", hour: 14, labelKey: "onboarding.wisdom.afternoon" as const },
  { key: "evening", hour: 19, labelKey: "onboarding.wisdom.evening" as const },
] as const
</script>

<style scoped>
.ob-wisdom {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 8px 16px 24px;
  box-sizing: border-box;
}
.ob-wisdom__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
  padding: 0 8px;
}
.ob-wisdom__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-wisdom__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-wisdom__card {
  width: 100%;
  max-width: 440px;
  margin-inline: auto;
}
.ob-wisdom__presets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
</style>
