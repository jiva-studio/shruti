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
  <div v-show="loaded" class="mx-auto max-w-6xl px-5 text-center">
    <p class="text-base text-coffee sm:text-lg">
      <span class="font-bold text-ink">{{ countText }}</span> {{ t('library.lectures') }}
      <span class="mx-2 text-coffee/40">·</span>
      <span class="font-bold text-ink">{{ hoursText }}</span> {{ t('library.hours') }}
    </p>
  </div>
</template>
