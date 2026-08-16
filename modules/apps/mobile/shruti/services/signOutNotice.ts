/**
 * What the sign-out toast is allowed to claim (#1883).
 *
 * Signing out wipes the device, and the notice afterwards was a fixed
 * sentence: "Your notes and chats stay in your account and come back when you
 * sign in." Three ways that was false or incomplete:
 *
 *  - **Chat, with "Sync chats" off.** Journaling is gated by
 *    `isChatSyncEnabled()`, so with the toggle off nothing was ever pushed and
 *    the server has no copy; `dataWipe` then destroys the only one.
 *  - **Anything still in the outbox.** The farewell push is bounded at 8 s and
 *    a device that is offline at that moment loses every row since the last
 *    successful cycle.
 *  - **The downloads.** The wipe deletes the whole offline library, and those
 *    do not "come back" — they must be re-fetched, potentially gigabytes on
 *    metered data.
 *
 * There is deliberately no confirmation dialog (a dialog on a handed-over
 * phone is answered by the wrong person), which is exactly why the notice has
 * to be true: it is the only thing the user is ever told.
 *
 * Kept as a pure key selector so the choice is testable without a toast, a
 * store or an i18n runtime, and so every branch is visible in one place.
 */

/** The base sentence: what happened to the notes, the chats and the downloads. */
const BASE_SYNCED = "settings.account.signOutWipeToast"

/**
 * Same, for a device where "Sync chats" was off. The chats were never eligible
 * to sync, so the wipe deleted the only copy and the notice says so rather
 * than promising their return.
 */
const BASE_CHAT_LOCAL = "settings.account.signOutWipeToastChatLocal"

/** Appended when the farewell push left rows behind. */
const UNSENT_SUFFIX = "settings.account.signOutWipeUnsentSuffix"

export interface SignOutFacts {
  /**
   * Whether chat was eligible to reach the server at all — the device-local
   * "Sync chats" toggle (`useSyncChatsEnabled`), read BEFORE the wipe.
   */
  readonly chatSynced: boolean
  /**
   * Whether the farewell outbox flush left pending rows behind
   * (`OutboxFlushResult.stranded`).
   */
  readonly stranded: boolean
}

/**
 * The i18n keys of the sign-out notice, in the order they read as one message.
 * Always at least one; the caller joins the translations with a space.
 */
export function signOutNoticeKeys(facts: SignOutFacts): readonly string[] {
  const keys = [facts.chatSynced ? BASE_SYNCED : BASE_CHAT_LOCAL]
  if (facts.stranded) keys.push(UNSENT_SUFFIX)
  return keys
}
