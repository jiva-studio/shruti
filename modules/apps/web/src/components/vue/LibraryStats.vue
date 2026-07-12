<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useT } from '../../i18n/ui'
import type { Lang } from '../../i18n/locales'

const props = defineProps<{ lang: Lang }>()
const t = useT(props.lang)

const BACKEND_FALLBACK = 'https://api.shruti.local'
const ANALYTICS = (import.meta.env.PUBLIC_ANALYTICS_URL as string | undefined)?.replace(/\/$/, '') ?? BACKEND_FALLBACK

const NUMBER_LOCALE: Record<string, string> = {
  ru: 'ru',
  en: 'en',
  uk: 'uk',
  'sr-latn': 'sr-Latn',
  'sr-cyrl': 'sr-Cyrl',
}

const loaded = ref(false)
const lectureCount = ref(0)
const totalHours = ref(0)

function nf(n: number): string {
  try {
    return new Intl.NumberFormat(NUMBER_LOCALE[props.lang] ?? 'en').format(n)
  } catch {
    return String(n)
  }
}

const countText = computed(() => nf(lectureCount.value))
const hoursText = computed(() => nf(totalHours.value))

async function load(): Promise<void> {
  if (!ANALYTICS) return
  try {
    const res = await fetch(`${ANALYTICS}/analytics/reports/library_totals`)
    if (!res.ok) return
    const body = await res.json()
    if (!body?.ok || !body?.result) return
    lectureCount.value = body.result.lecture_count || 0
    totalHours.value = Math.round((body.result.total_duration_seconds || 0) / 3600)
    loaded.value = true
  } catch {
    // Unavailable → stay hidden.
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div v-show="loaded" class="h-full">
    <!-- Second band beside the listened-counter: same dark rounded-2xl style,
         its own OpenRouter-generated background (cand-lit library of old books
         + palm-leaf manuscripts). h-full so both bands align. -->
    <div class="relative flex h-full flex-col justify-center overflow-hidden rounded-2xl bg-ink px-7 py-16 text-center text-cream sm:px-10">
      <img
        src="/library-bg.jpg"
        alt=""
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
      />
      <div class="pointer-events-none absolute inset-0 bg-ink/45"></div>
      <div class="relative">
        <p class="text-sm font-semibold uppercase tracking-wide text-cream/70">
          {{ t('library.eyebrow') }}
        </p>
        <div class="mt-5 flex flex-wrap items-end justify-center gap-x-8 gap-y-4">
          <div>
            <div class="text-5xl font-bold tabular-nums text-cream drop-shadow sm:text-6xl">{{ countText }}</div>
            <div class="mt-1.5 text-xs font-semibold uppercase tracking-wide text-cream/60">
              {{ t('library.lectures') }}
            </div>
          </div>
          <div>
            <div class="text-3xl font-bold tabular-nums text-cream/90 drop-shadow sm:text-4xl">{{ hoursText }}</div>
            <div class="mt-1.5 text-xs font-semibold uppercase tracking-wide text-cream/60">
              {{ t('library.hours') }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
