import { describe, expect, it } from "vitest"
import type { AuthSession } from "@ports/app/auth.js"
import { readSessionFields } from "../sessionFields.js"

const SESSION: AuthSession = {
  userId: "u-1",
  email: "a@b.c",
  name: "Reader",
  picture: null,
  anonymous: false,
  accessTokenExpiresAt: 0,
  tier: "pro",
  tierExpiresAt: 1_700_000_000_000,
  quotaId: "q-1",
}

describe("readSessionFields", () => {
  it("mirrors a signed-in session", () => {
    expect(readSessionFields(SESSION)).toEqual({
      userId: "u-1",
      email: "a@b.c",
      name: "Reader",
      picture: null,
      anonymous: false,
      rawTier: "pro",
      tierExpiresAt: 1_700_000_000_000,
      quotaId: "q-1",
      status: "signedIn",
    })
  })

  it("reports an anonymous session as such without losing its identity", () => {
    const fields = readSessionFields({ ...SESSION, anonymous: true })
    expect(fields.status).toBe("anonymous")
    expect(fields.userId).toBe("u-1")
  })

  it("falls back to the free tier when the server sends an empty one", () => {
    expect(readSessionFields({ ...SESSION, tier: "" }).rawTier).toBe("free")
  })

  it("normalizes a missing quota id to the empty string", () => {
    const { quotaId, ...rest } = readSessionFields({
      ...SESSION,
      quotaId: undefined as unknown as string,
    })
    expect(quotaId).toBe("")
    expect(rest.userId).toBe("u-1")
  })

  it("resets every field for a signed-out session", () => {
    expect(readSessionFields(null)).toEqual({
      userId: null,
      email: null,
      name: null,
      picture: null,
      anonymous: true,
      rawTier: "free",
      tierExpiresAt: null,
      quotaId: "",
      status: "uninitialized",
    })
  })
})
