export type ScrollableHost = HTMLElement & { getScrollElement?: () => Promise<HTMLElement> }

/** Scroll offset that puts a chapter heading just below the top edge. */
export function headingScrollTop(scrollTop: number, headingTop: number, hostTop: number): number {
  // Small gap so the heading isn't flush against the safe-area edge.
  const gap = 12
  return Math.max(0, scrollTop + (headingTop - hostTop) - gap)
}

export async function scrollToChapterHeading(
  contentEl: ScrollableHost | undefined,
  startMs: number
): Promise<void> {
  if (!contentEl?.getScrollElement) return
  const scrollEl = await contentEl.getScrollElement()
  const heading = contentEl.querySelector<HTMLElement>(`[data-heading-start="${startMs}"]`)
  if (!heading) return
  const top = headingScrollTop(
    scrollEl.scrollTop,
    heading.getBoundingClientRect().top,
    scrollEl.getBoundingClientRect().top
  )
  scrollEl.scrollTo({ top, behavior: "smooth" })
}
