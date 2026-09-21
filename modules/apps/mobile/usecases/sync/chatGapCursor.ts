/**
 * The watermark that lets "Sync chats" be turned back on without losing the
 * conversations skipped while it was off. The pull cursor is global and
 * advances over skipped rows, so without a floor to rewind to nothing would
 * ever ask the server for them again.
 */
export interface ChatGapState {
  readonly chatEnabled: boolean
  /** The outstanding gap as the cycle found it, or null for none. */
  readonly gapBefore: number | null
  /** Cursor at the first page this cycle passed a chat change over. */
  readonly skippedAt: number | null
  /** Whether pagination ran out of pages rather than being cut short — the
   *  only proof that everything from the gap onwards has been re-pulled. */
  readonly caughtUp: boolean
}

/** The value to store, or `undefined` to leave the stored watermark alone. */
export type ChatGapWrite = number | null | undefined

/**
 * The watermark is a FLOOR, and it clears only once a full re-pull from it has
 * completed. Taking the newer skip point instead would let a second off→on
 * cycle overwrite the earlier, lower gap and strand the first period's
 * conversations for good.
 */
export function nextChatGapCursor(state: ChatGapState): ChatGapWrite {
  if (state.chatEnabled) {
    return state.gapBefore !== null && state.caughtUp ? null : undefined
  }
  if (state.skippedAt === null) return undefined
  const { gapBefore, skippedAt } = state
  const floor = gapBefore === null ? skippedAt : Math.min(gapBefore, skippedAt)
  return floor === gapBefore ? undefined : floor
}

/**
 * Where the next pull must restart when the toggle comes back on with a gap
 * outstanding, or null to leave the cursor alone. Rewinding below `acked_seq`
 * is safe — the ack is a compaction hint the server never acts on
 * destructively, and it is re-sent once the cursor climbs past it again.
 */
export function rewindCursorForChatGap(
  chatEnabled: boolean,
  gapBefore: number | null,
  cursor: number
): number | null {
  if (!chatEnabled || gapBefore === null) return null
  return gapBefore < cursor ? gapBefore : null
}
