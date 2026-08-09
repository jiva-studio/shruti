// Shared pagination for the browse index pages (collections, topics). Page 1
// keeps the bare URL (/app/collections); pages 2+ live under /page/N so the
// first page stays canonical for indexing.
export const BROWSE_PAGE_SIZE = 24

export interface Paged<T> {
  items: T[]
  page: number
  totalPages: number
}

export function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / BROWSE_PAGE_SIZE))
}

export function pageSlice<T>(items: T[], page: number): Paged<T> {
  const pages = totalPages(items.length)
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages)
  const start = (p - 1) * BROWSE_PAGE_SIZE
  return { items: items.slice(start, start + BROWSE_PAGE_SIZE), page: p, totalPages: pages }
}

export function pageHref(base: string, page: number): string {
  return page <= 1 ? base : `${base}/page/${page}`
}
