import { describe, expect, it } from "vitest"
import { signOutNoticeKeys } from "../signOutNotice.js"
import en from "@shruti/i18n/locales/en/settings.js"

/**
 * #1883. The sign-out notice is the only thing the user is ever told — there
 * is deliberately no confirmation dialog, because one on a handed-over phone
 * is answered by the wrong person. That makes the notice's truthfulness the
 * whole safeguard, and it used to be a single fixed sentence promising that
 * notes and chats "come back when you sign in".
 *
 * These assert the two things that make the sentence conditional: whether chat
 * had a server copy at all, and whether the farewell push delivered.
 */

function lookup(key: string): string {
  const path = key.replace(/^settings\./, "").split(".")
  let node: unknown = en
  for (const part of path) node = (node as Record<string, unknown>)[part]
  expect(typeof node).toBe("string")
  return node as string
}

const notice = (facts: { chatSynced: boolean; stranded: boolean }): string =>
  signOutNoticeKeys(facts).map(lookup).join(" ")

describe("signOutNoticeKeys", () => {
  it("promises chat back only when chat sync was on", () => {
    expect(signOutNoticeKeys({ chatSynced: true, stranded: false })).toEqual([
      "settings.account.signOutWipeToast",
    ])
    expect(notice({ chatSynced: true, stranded: false })).toContain("chats stay in your account")
  })

  it("says chat was deleted when chat sync was off", () => {
    expect(signOutNoticeKeys({ chatSynced: false, stranded: false })).toEqual([
      "settings.account.signOutWipeToastChatLocal",
    ])

    // Journaling is gated by `isChatSyncEnabled()`, so with the toggle off the
    // server never held a copy and the wipe destroyed the only one. The notice
    // must not claim otherwise.
    const text = notice({ chatSynced: false, stranded: false })
    expect(text).toMatch(/deleted/i)
    expect(text).not.toContain("chats stay in your account")
  })

  it("names the downloads in every variant", () => {
    // The wipe runs `mediaItems.clearAll()` + `filesStorage.clearAll()`, and
    // downloads do NOT come back on the next sign-in — they are re-fetched,
    // potentially gigabytes on metered data.
    for (const chatSynced of [true, false]) {
      expect(notice({ chatSynced, stranded: false })).toMatch(/downloaded lectures/i)
    }
  })

  it("admits the loss when the farewell push left rows behind", () => {
    expect(signOutNoticeKeys({ chatSynced: true, stranded: true })).toEqual([
      "settings.account.signOutWipeToast",
      "settings.account.signOutWipeUnsentSuffix",
    ])
    expect(notice({ chatSynced: true, stranded: true })).toMatch(/lost/i)
  })

  it("combines both losses when both happened", () => {
    expect(signOutNoticeKeys({ chatSynced: false, stranded: true })).toEqual([
      "settings.account.signOutWipeToastChatLocal",
      "settings.account.signOutWipeUnsentSuffix",
    ])
  })

  it("never says anything was lost when the flush delivered", () => {
    for (const chatSynced of [true, false]) {
      expect(notice({ chatSynced, stranded: false })).not.toMatch(/lost/i)
    }
  })
})
