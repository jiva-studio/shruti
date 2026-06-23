import { computed, ref, type ComputedRef, type Ref } from 'vue'

export interface Pagination<T> {
  page: Ref<number>
  pageCount: ComputedRef<number>
  visible: ComputedRef<T[]>
  pageWindow: ComputedRef<(number | '…')[]>
  goTo: (p: number) => void
}

export function usePagination<T>(
  items: Ref<T[]> | ComputedRef<T[]>,
  perPage: number,
  onNavigate?: () => void
): Pagination<T> {
  const page = ref(1)

  const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / perPage)))

  const visible = computed<T[]>(() => {
    const start = (page.value - 1) * perPage
    return items.value.slice(start, start + perPage)
  })

  const pageWindow = computed<(number | '…')[]>(() => {
    const total = pageCount.value
    const cur = page.value
    const span = 2
    const out: (number | '…')[] = []
    const from = Math.max(1, cur - span)
    const to = Math.min(total, cur + span)
    if (from > 1) {
      out.push(1)
      if (from > 2) out.push('…')
    }
    for (let p = from; p <= to; p++) out.push(p)
    if (to < total) {
      if (to < total - 1) out.push('…')
      out.push(total)
    }
    return out
  })

  function goTo(p: number) {
    page.value = Math.min(Math.max(1, p), pageCount.value)
    onNavigate?.()
  }

  return { page, pageCount, visible, pageWindow, goTo }
}
