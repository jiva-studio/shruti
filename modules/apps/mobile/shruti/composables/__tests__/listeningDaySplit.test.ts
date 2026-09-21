import { describe, expect, it, vi } from "vitest"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import {
  midnightSlice,
  msToSec,
  splitSessionAtMidnights,
  startOfNextLocalDay,
} from "../listeningDaySplit.js"

const at = (iso: string) => new Date(iso).getTime()
const ITEM = "item-1" as PlaylistItemId

describe("msToSec", () => {
  it("floors to whole seconds", () => {
    expect(msToSec(1999)).toBe(1)
  })

  it("clamps junk to zero", () => {
    expect(msToSec(-5)).toBe(0)
    expect(msToSec(Number.NaN)).toBe(0)
  })
})

describe("startOfNextLocalDay", () => {
  it("lands on the next local midnight", () => {
    const next = startOfNextLocalDay(at("2026-03-10T22:30:00"))
    expect(new Date(next).getHours()).toBe(0)
    expect(new Date(next).getDate()).toBe(11)
  })
})

describe("midnightSlice", () => {
  it("is null while the session stays inside one local day", () => {
    const slice = midnightSlice(
      { openedAtMs: at("2026-03-10T10:00:00"), openPositionMs: 0 },
      600_000,
      at("2026-03-10T23:59:00")
    )
    expect(slice).toBeNull()
  })

  it("interpolates the boundary position from wall-clock elapsed", () => {
    const slice = midnightSlice(
      { openedAtMs: at("2026-03-10T23:50:00"), openPositionMs: 60_000 },
      3_000_000,
      at("2026-03-11T00:20:00")
    )
    expect(slice?.boundaryMs).toBe(at("2026-03-11T00:00:00"))
    expect(slice?.boundaryPositionMs).toBe(60_000 + 600_000)
  })

  it("never reports a boundary past the current position", () => {
    const slice = midnightSlice(
      { openedAtMs: at("2026-03-10T20:00:00"), openPositionMs: 0 },
      5_000,
      at("2026-03-11T09:00:00")
    )
    expect(slice?.boundaryPositionMs).toBe(5_000)
  })
})

function fakeRepo() {
  let next = 0
  const finished: { id: string; position: number; endedAtSec: number }[] = []
  const repo = {
    finishAt: vi.fn(
      async (id: ListeningSessionId, args: { position: number; endedAtSec: number }) => {
        finished.push({ id: String(id), ...args })
      }
    ),
    forceStart: vi.fn(async () => `s${++next}` as ListeningSessionId),
  }
  return { repo: repo as unknown as IListeningSessionRepository, finished, calls: repo }
}

describe("splitSessionAtMidnights", () => {
  it("leaves a same-day session untouched", async () => {
    const { repo, calls } = fakeRepo()
    const cursor = {
      sessionId: "s0" as ListeningSessionId,
      itemId: ITEM,
      openedAtMs: at("2026-03-10T10:00:00"),
      openPositionMs: 0,
    }
    const out = await splitSessionAtMidnights(repo, cursor, 600_000, at("2026-03-10T12:00:00"))
    expect(out).toBe(cursor)
    expect(calls.finishAt).not.toHaveBeenCalled()
  })

  it("emits one row per spanned local day and returns the last continuation", async () => {
    const { repo, finished, calls } = fakeRepo()
    const out = await splitSessionAtMidnights(
      repo,
      {
        sessionId: "s0" as ListeningSessionId,
        itemId: ITEM,
        openedAtMs: at("2026-03-10T23:00:00"),
        openPositionMs: 0,
      },
      7_200_000,
      at("2026-03-13T01:00:00")
    )
    expect(calls.forceStart).toHaveBeenCalledTimes(3)
    expect(finished.map((f) => f.id)).toEqual(["s0", "s1", "s2"])
    expect(out.sessionId).toBe("s3")
    expect(out.openedAtMs).toBe(at("2026-03-13T00:00:00"))
  })

  it("closes each row on the last second of the day it opened on", async () => {
    const { repo, finished } = fakeRepo()
    await splitSessionAtMidnights(
      repo,
      {
        sessionId: "s0" as ListeningSessionId,
        itemId: ITEM,
        openedAtMs: at("2026-03-10T23:30:00"),
        openPositionMs: 0,
      },
      3_600_000,
      at("2026-03-11T02:00:00")
    )
    expect(finished[0].endedAtSec).toBe(msToSec(at("2026-03-11T00:00:00")) - 1)
  })
})
