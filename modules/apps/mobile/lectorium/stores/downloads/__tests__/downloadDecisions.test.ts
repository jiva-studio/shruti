import { describe, expect, it } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import { classifyTransferResult, decideBudget } from "../downloadDecisions.js"

const SERVER = { id: "global", urlTemplate: "https://cdn.test/{path}" } as CdnServer

const ROOM = {
  exempt: false,
  onDisk: false,
  hasRoom: true,
  origin: "user",
  measured: true,
} as const
const FULL = { ...ROOM, hasRoom: false }

describe("decideBudget", () => {
  it("admits a transfer the budget has room for", () => {
    expect(decideBudget(ROOM)).toEqual({ kind: "admit" })
  })

  it("defers a transfer the budget cannot fund", () => {
    expect(decideBudget(FULL)).toEqual({ kind: "defer", announce: true })
  })

  it("admits on a granted pass without widening the limit", () => {
    expect(decideBudget({ ...FULL, exempt: true })).toEqual({ kind: "admit" })
  })

  it("admits bytes already on disk, which ask the device for no new space", () => {
    expect(decideBudget({ ...FULL, onDisk: true })).toEqual({ kind: "admit" })
  })

  it("says nothing about a refusal the queue brought on itself", () => {
    expect(decideBudget({ ...FULL, origin: "queue" })).toEqual({ kind: "defer", announce: false })
  })

  it("does not claim storage is full when the budget was never measured", () => {
    expect(decideBudget({ ...FULL, measured: false })).toEqual({ kind: "defer", announce: false })
  })
})

describe("classifyTransferResult", () => {
  it("reads a delivered transfer as saved, with the server that delivered it", () => {
    const result = {
      ok: true as const,
      value: { server: SERVER, mediaItem: { localPath: "file:///local.mp3" } },
    }

    expect(classifyTransferResult(result as never)).toEqual({
      kind: "saved",
      localPath: "file:///local.mp3",
      server: SERVER,
    })
  })

  it("keeps a cancel apart from a failure, so no retry affordance is painted", () => {
    expect(classifyTransferResult({ ok: false, error: "cancelled" } as never)).toEqual({
      kind: "cancelled",
    })
  })

  it("carries the cause through, so the notice can name the right one", () => {
    expect(classifyTransferResult({ ok: false, error: "persist-failed" } as never)).toEqual({
      kind: "failed",
      cause: "persist-failed",
    })
    expect(classifyTransferResult({ ok: false, error: "no-candidates" } as never)).toEqual({
      kind: "failed",
      cause: "no-candidates",
    })
  })
})
