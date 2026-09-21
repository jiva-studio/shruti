import { nextTick, ref, watch, type Ref } from "vue"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { findLastUserMessageId } from "./chatScroll.js"

export interface UseChatScrollReturn {
  /** The IonContent's inner scroller, captured on the wrapper div. */
  contentRef: Ref<HTMLElement | null>
  scrollMessageToTop: (messageId: string, behavior?: ScrollBehavior) => void
  /** Async because `IonContent.scrollToBottom()` awaits `getScrollElement()`
   *  before it applies the position — callers must await it. */
  scrollToBottom: (durationMs?: number) => Promise<void>
}

/**
 * Scroll control for the message list, plus the rule that pins a just-sent
 * question to the top of the viewport while the answer streams in below. The
 * reply is never chased downward: the user reads at their own pace.
 */
export function useChatScroll(): UseChatScrollReturn {
  const store = useChatStore()
  const contentRef = ref<HTMLElement | null>(null)

  /**
   * Native `scrollIntoView({ block: "start" })` paired with
   * `scroll-margin-top` on `.bubble-row`, so the row lands below the
   * fixed-top fade rather than under it.
   */
  function scrollMessageToTop(messageId: string, behavior: ScrollBehavior = "smooth"): void {
    const el = contentRef.value
    if (!el) return
    const target = el.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    ) as HTMLElement | null
    target?.scrollIntoView({ block: "start", behavior })
  }

  async function scrollToBottom(durationMs = 0): Promise<void> {
    const el = contentRef.value
    if (!el) return
    const host = el.closest("ion-content") as
      | (HTMLElement & { scrollToBottom?: (durationMs: number) => Promise<void> })
      | null
    if (host && typeof host.scrollToBottom === "function") await host.scrollToBottom(durationMs)
    else el.scrollTop = el.scrollHeight
  }

  async function pinLastQuestion(): Promise<void> {
    const last = store.messages[store.messages.length - 1]
    if (!last) return
    const isPlaceholder = last.role === "assistant" && last.streaming === true
    const isUserMessage = last.role === "user"
    if (!isUserMessage && !isPlaceholder) return
    await nextTick()
    // Wait for layout: the placeholder's `min-height` only takes effect after
    // the next paint, and without that height there is not enough scroll room
    // to pin the question — the browser silently clamps scrollTop instead.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const target = isUserMessage ? last.id : findLastUserMessageId(store.messages)
    if (target) scrollMessageToTop(target)
  }

  // A composite string key, because the store replaces `messages` immutably on
  // every SSE event and a reference-comparing watcher would yank the reader
  // back to the top after each one. Only id/role/streaming belong in it: a
  // delta mutates the same placeholder and must not re-fire.
  watch(
    () => {
      const last = store.messages[store.messages.length - 1]
      if (!last) return ""
      return `${last.role}|${last.id}|${last.streaming ? "1" : "0"}`
    },
    (key, prev) => {
      if (!key || key === prev) return
      void pinLastQuestion()
    }
  )

  return { contentRef, scrollMessageToTop, scrollToBottom }
}
