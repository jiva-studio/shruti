<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useT } from '../../i18n/ui'
import type { Lang } from '../../i18n/locales'

const props = defineProps<{ lang: Lang }>()
const t = useT(props.lang)

// The analytics service is on the same Global origin as the other backends
// (Caddy routes /analytics/* and serves CORS *). Empty/unset → widget hides.
const BACKEND_FALLBACK = 'https://api.shruti.local'
const ANALYTICS = (import.meta.env.PUBLIC_ANALYTICS_URL as string | undefined)?.replace(/\/$/, '') ?? BACKEND_FALLBACK

// How much history to sum for the base total, and how many trailing complete
// days to average for the growth rate. The report is dumb (seconds per day);
// ALL derived logic — base sum, velocity, extrapolation — lives here.
const WINDOW_DAYS = 365
const RATE_WINDOW_DAYS = 14

// BCP-47 tag for Intl number grouping (site lang codes are lowercased).
const NUMBER_LOCALE: Record<string, string> = {
  ru: 'ru',
  en: 'en',
  uk: 'uk',
  'sr-latn': 'sr-Latn',
  'sr-cyrl': 'sr-Cyrl',
}

interface DayPoint {
  date: string
  seconds: number
}

const loaded = ref(false)
const baseSeconds = ref(0)
const ratePerSecond = ref(0) // listened-seconds accrued per real second
const asOfMs = ref(0)
const nowMs = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

// Live extrapolated total: the base as of the server's compute time, plus the
// growth rate times the elapsed wall-clock since then.
const liveSeconds = computed(() => {
  if (!loaded.value) return 0
  const elapsed = Math.max(0, (nowMs.value - asOfMs.value) / 1000)
  return baseSeconds.value + ratePerSecond.value * elapsed
})

const hours = computed(() => Math.floor(liveSeconds.value / 3600))
const minutes = computed(() => Math.floor((liveSeconds.value % 3600) / 60))

const hoursText = computed(() => {
  const loc = NUMBER_LOCALE[props.lang] ?? 'en'
  try {
    return new Intl.NumberFormat(loc).format(hours.value)
  } catch {
    return String(hours.value)
  }
})

function ymdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function load(): Promise<void> {
  if (!ANALYTICS) return
  try {
    const today = new Date()
    const from = new Date(today)
    from.setDate(from.getDate() - (WINDOW_DAYS - 1))
    // Bucket by the visitor's own local days so "today" lines up with them.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const qs = new URLSearchParams({
      from: ymdLocal(from),
      to: ymdLocal(today),
      tz,
    })
    const res = await fetch(`${ANALYTICS}/analytics/reports/listening_daily?${qs.toString()}`)
    if (!res.ok) return
    const body = await res.json()
    if (!body?.ok || !body?.result?.days) return

    const days: DayPoint[] = body.result.days
    baseSeconds.value = days.reduce((acc, d) => acc + (d.seconds || 0), 0)

    // Rate from the trailing COMPLETE days (exclude today — it's partial and
    // would understate velocity). Fall back to the whole window if short.
    const complete = days.slice(0, -1)
    const rateDays = complete.slice(-RATE_WINDOW_DAYS)
    const sample = rateDays.length > 0 ? rateDays : days
    const sampleSeconds = sample.reduce((acc, d) => acc + (d.seconds || 0), 0)
    ratePerSecond.value = sample.length > 0 ? sampleSeconds / (sample.length * 86400) : 0

    asOfMs.value = typeof body.generated_at === 'number' ? body.generated_at : Date.now()
    nowMs.value = Date.now()
    loaded.value = true

    // Tick the display every second. We render hours+minutes, so a 1s cadence
    // is plenty; the minute rolls over as global listening accrues.
    timer = setInterval(() => {
      nowMs.value = Date.now()
    }, 1000)
  } catch {
    // Network/parse failure → widget stays hidden (loaded=false).
  }
}

onMounted(() => {
  void load()
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="loaded" class="mx-auto max-w-2xl px-5 text-center">
    <div
      class="rounded-3xl border border-coffee/10 bg-cream/60 px-6 py-10 shadow-sm backdrop-blur"
    >
      <p class="text-sm font-semibold uppercase tracking-wide text-coffee/70">
        {{ t('counter.eyebrow') }}
      </p>
      <p class="mt-3 flex flex-wrap items-baseline justify-center gap-x-2 gap-y-1">
        <span class="text-5xl font-bold tabular-nums text-ink sm:text-6xl">{{ hoursText }}</span>
        <span class="text-2xl font-semibold text-coffee sm:text-3xl">{{ t('counter.hUnit') }}</span>
        <span class="text-5xl font-bold tabular-nums text-ink sm:text-6xl">{{ minutes }}</span>
        <span class="text-2xl font-semibold text-coffee sm:text-3xl">{{ t('counter.mUnit') }}</span>
      </p>
      <p class="mx-auto mt-4 max-w-md text-base leading-relaxed text-medium">
        {{ t('counter.sub') }}
      </p>
    </div>
  </div>
</template>
