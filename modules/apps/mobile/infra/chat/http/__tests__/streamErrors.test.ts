import { describe, expect, it } from "vitest"

import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"

import {
  rateLimitedEvent,
  readRateLimitDetail,
  throwIfBackendUnavailable,
  throwProtocolMismatch,
} from "../streamErrors.js"

const withDetail = (status: number, detail: unknown): Response =>
  new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  })

describe("throwProtocolMismatch", () => {
  it("carries the versions the server named", async () => {
    const error = await throwProtocolMismatch(
      withDetail(426, { supported: [2, 3], received: 1 })
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ProtocolVersionMismatchError)
    expect((error as ProtocolVersionMismatchError).serverSupported).toEqual([2, 3])
    expect((error as ProtocolVersionMismatchError).clientSent).toBe(1)
  })

  it("reads versions the server sent as strings", async () => {
    const error = await throwProtocolMismatch(
      withDetail(426, { supported: ["2", "3"], received: "1" })
    ).catch((e: unknown) => e)

    expect((error as ProtocolVersionMismatchError).serverSupported).toEqual([2, 3])
    expect((error as ProtocolVersionMismatchError).clientSent).toBe(1)
  })

  it("drops entries that are not numbers at all", async () => {
    const error = await throwProtocolMismatch(
      withDetail(426, { supported: [2, "abc", null] })
    ).catch((e: unknown) => e)

    expect((error as ProtocolVersionMismatchError).serverSupported).toEqual([2])
    expect((error as ProtocolVersionMismatchError).clientSent).toBeUndefined()
  })

  it("still throws when an older server sends no detail at all", async () => {
    const error = await throwProtocolMismatch(new Response("nope", { status: 426 })).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(ProtocolVersionMismatchError)
    expect((error as ProtocolVersionMismatchError).serverSupported).toBeUndefined()
  })

  it("ignores a detail that is an array rather than an object", async () => {
    const error = await throwProtocolMismatch(withDetail(426, [1, 2])).catch((e: unknown) => e)

    expect((error as ProtocolVersionMismatchError).serverSupported).toBeUndefined()
  })
})

describe("readRateLimitDetail", () => {
  it("reads every field the usage chip hydrates from", async () => {
    const detail = await readRateLimitDetail(
      withDetail(429, {
        tier: "free",
        resets_at_epoch: 1_800_000_000,
        current: 5,
        limit: 5,
        key_type: "user",
      })
    )

    expect(detail).toEqual({
      tier: "free",
      resetsAtEpoch: 1_800_000_000,
      current: 5,
      limit: 5,
      keyType: "user",
    })
  })

  it("returns nothing at all for a 429 with no detail", async () => {
    expect(await readRateLimitDetail(new Response("", { status: 429 }))).toEqual({})
  })

  it("drops fields whose type does not match the contract", async () => {
    const detail = await readRateLimitDetail(
      withDetail(429, {
        tier: 7,
        resets_at_epoch: "soon",
        current: null,
        limit: "5",
        key_type: "device",
      })
    )

    expect(detail).toEqual({
      tier: undefined,
      resetsAtEpoch: undefined,
      current: undefined,
      limit: undefined,
      keyType: undefined,
    })
  })

  it("accepts an ip-keyed limit", async () => {
    expect((await readRateLimitDetail(withDetail(429, { key_type: "ip" }))).keyType).toBe("ip")
  })
})

describe("rateLimitedEvent", () => {
  it("omits what the server did not say rather than inventing it", () => {
    expect(rateLimitedEvent({}, undefined)).toEqual({
      type: "error",
      code: "rate_limited",
      message: "Too many requests",
    })
  })

  it("passes the server's own numbers through", () => {
    expect(rateLimitedEvent({ tier: "pro", limit: 50, current: 50 }, 12)).toEqual({
      type: "error",
      code: "rate_limited",
      message: "Too many requests",
      retryAfter: 12,
      tier: "pro",
      current: 50,
      limit: 50,
    })
  })
})

describe("throwIfBackendUnavailable", () => {
  it("raises on a quota store that is structurally down", async () => {
    await expect(
      throwIfBackendUnavailable(withDetail(503, { code: "rate_limit_backend_unavailable" }))
    ).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it("lets a plain 503 through, since retrying it may well work", async () => {
    await expect(
      throwIfBackendUnavailable(new Response("bad gateway", { status: 503 }))
    ).resolves.toBeUndefined()
  })

  it("lets a 503 with an unrelated code through", async () => {
    await expect(
      throwIfBackendUnavailable(withDetail(503, { code: "upstream_timeout" }))
    ).resolves.toBeUndefined()
  })
})
