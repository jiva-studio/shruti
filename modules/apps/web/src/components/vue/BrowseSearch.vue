<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'

interface Item {
  slug: string
  name: string
  count: number
  cover: string | null
}

const props = defineProps<{
  items: Item[]
  hrefBase: string
  lecturesWord: string
  placeholder: string
  noResults: string
}>()

const q = ref('')

// Mirror the query in the URL (?q=…) so a search is shareable: type, copy the
// address, send it, and the recipient lands on the same filtered view. Seed
// from the URL on mount; write back (debounced, replaceState so Back isn't
// spammed) as the user types.
const QUERY_PARAM = 'q'

onMounted(() => {
  const seed = new URLSearchParams(window.location.search).get(QUERY_PARAM)
  if (seed) q.value = seed
})

let syncTimer: ReturnType<typeof setTimeout> | undefined
watch(q, (val) => {
  if (typeof window === 'undefined') return
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const url = new URL(window.location.href)
    const v = val.trim()
    if (v) url.searchParams.set(QUERY_PARAM, v)
    else url.searchParams.delete(QUERY_PARAM)
    window.history.replaceState(null, '', url)
  }, 250)
})

// Diacritic-insensitive, case-insensitive contains match.
function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const active = computed(() => norm(q.value).length > 0)

const results = computed(() => {
  const n = norm(q.value)
  if (!n) return []
  return props.items.filter((it) => norm(it.name).includes(n)).slice(0, 60)
})
</script>

<template>
  <div>
    <div class="relative max-w-xl">
      <svg
        class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" stroke-linecap="round" />
      </svg>
      <input
        v-model="q"
        type="search"
        :placeholder="placeholder"
        class="w-full rounded-xl border border-line bg-cream-deep py-3 pl-12 pr-4 text-ink shadow-sm outline-none transition focus:border-saffron/60 focus:ring-2 focus:ring-saffron/20"
      />
    </div>

    <div v-if="active" class="mt-8">
      <div v-if="results.length" class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <a
          v-for="it in results"
          :key="it.slug"
          :href="hrefBase + it.slug"
          class="flex flex-col overflow-hidden rounded-2xl border border-line bg-cream-deep transition hover:border-saffron/40 hover:shadow-md"
        >
          <img
            v-if="it.cover"
            :src="it.cover"
            alt=""
            loading="lazy"
            width="400"
            height="267"
            class="aspect-[3/2] w-full object-cover"
          />
          <div class="flex flex-1 flex-col px-4 py-3">
            <h3 class="font-serif text-base font-semibold leading-snug text-ink">{{ it.name }}</h3>
            <p class="mt-1 text-xs text-medium">{{ it.count }} {{ lecturesWord }}</p>
          </div>
        </a>
      </div>
      <p v-else class="py-10 text-center text-medium">{{ noResults }}</p>
    </div>

    <div v-show="!active">
      <slot />
    </div>
  </div>
</template>
