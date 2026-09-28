import { describe, expect, it } from "vitest"
import type { PushResponse } from "@lib/contracts"
import type { IClock } from "@lib/domain/ports/clock.js"
import { pushLocal } from "../pushLocal.js"
import {
  FakeApply,
  FakeOutbox,
  FakeSyncClient,
  FakeSyncState,
  fakeUnitOfWork,
  hlc,
} from "./fakes.js"

const acceptAll = (req: { changes: readonly { collection: string; doc_id: string }[] }) => ({
  applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
  conflicts: [],
})

function run(gateway: FakeSyncClient, outbox: FakeOutbox, apply: FakeApply, clock: IClock) {
  return pushLocal({
    gateway,
    outbox,
    apply,
    syncState: new FakeSyncState(),
    unitOfWork: fakeUnitOfWork,
    clock,
  })
}

describe("pushLocal — push body on the wire", () => {
  it("serialises every change with the installed clients' key order, and a delete without data", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    apply.setServerHlc("notes", "n1", hlc(500))
    outbox.seed([
      {
        collection: "notes",
        docId: "n1",
        op: "upsert",
        data: { id: "n1", text: "é‏" },
        hlc: hlc(1000),
        baseHlc: null,
      },
      {
        collection: "chat_sessions",
        docId: "s1",
        op: "delete",
        // A tombstone that still carries a row must not leak it onto the wire.
        data: { id: "s1", title: "stale" },
        hlc: hlc(1001),
        baseHlc: "",
      },
    ])
    gateway.pushHandler = acceptAll

    await run(gateway, outbox, apply, { now: () => 0 })

    expect(JSON.stringify(gateway.pushRequests[0])).toBe(
      JSON.stringify({
        device_id: "dev-1",
        changes: [
          {
            collection: "notes",
            doc_id: "n1",
            op: "upsert",
            data: { id: "n1", text: "é‏" },
            hlc: hlc(1000),
            base_hlc: hlc(500),
          },
          {
            collection: "chat_sessions",
            doc_id: "s1",
            op: "delete",
            hlc: hlc(1001),
            base_hlc: "",
          },
        ],
      })
    )
  })
})

describe("pushLocal — conflict re-merge stamps from the injected clock", () => {
  function conflictOnce(masterHlc: string) {
    return (req: Parameters<typeof acceptAll>[0], callIndex: number): PushResponse =>
      callIndex === 0
        ? {
            applied: [],
            conflicts: [
              {
                collection: "notes",
                doc_id: "n1",
                master: {
                  collection: "notes",
                  doc_id: "n1",
                  op: "upsert",
                  hlc: masterHlc,
                  data: { id: "n1", text: "server" },
                },
              },
            ],
          }
        : acceptAll(req)
  }

  function seeded(): FakeOutbox {
    const outbox = new FakeOutbox()
    outbox.seed([
      {
        collection: "notes",
        docId: "n1",
        op: "upsert",
        data: { id: "n1", text: "local" },
        hlc: hlc(1000),
        baseHlc: null,
      },
    ])
    return outbox
  }

  it("takes the physical half from the clock when it is ahead of the master", async () => {
    const gateway = new FakeSyncClient()
    gateway.pushHandler = conflictOnce(hlc(3000))

    await run(gateway, seeded(), new FakeApply(), { now: () => 7000 })

    expect(gateway.pushRequests[1]!.changes[0]!.hlc).toBe(hlc(7000, 0, "dev-1"))
  })

  it("advances the master's counter when the clock lags behind it", async () => {
    const gateway = new FakeSyncClient()
    gateway.pushHandler = conflictOnce(hlc(3000, 2, "zz"))

    await run(gateway, seeded(), new FakeApply(), { now: () => 10 })

    expect(gateway.pushRequests[1]!.changes[0]!.hlc).toBe(hlc(3000, 3, "dev-1"))
  })
})
