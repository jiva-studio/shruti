import { describe, it, expect } from "vitest"
import { parseMeta } from "@lib/domain/chat/messageMeta.js"
import { richFieldsToMeta, metaToRichFields } from "../canonicalMessage"
import {
  adoptBaseline,
  applyPushResponse,
  buildPushItems,
  diffOutbox,
  docKey,
  newState,
  outboxEmpty,
  reducePull,
  type MergePlan,
  type SnapshotChat,
  type SyncState,
} from "../profileSyncCore"
import type { PullResponse, PushItem, PushResponse } from "@lib/contracts"

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A serialized web message with a stable id/createdAt and some rich fields. */
function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  extra: Record<string, unknown> = {}
) {
  return { id, role, text, createdAt, ...extra } as SnapshotChat["messages"][number]
}

function chat(id: string, title: string, updatedAt: number, messages: SnapshotChat["messages"]): SnapshotChat {
  return { id, title, updatedAt, createdAt: messages[0]?.createdAt ?? updatedAt, messages }
}

/* -------------------------------------------------------------------------- */
/*  1. Canonical meta round-trip                                             */
/* -------------------------------------------------------------------------- */

describe("canonical meta codec", () => {
  it("round-trips shared + web-only rich fields", () => {
    const m = {
      id: "m1",
      role: "assistant" as const,
      text: "hello [verse:bg/2.13|x] [card:track_9]",
      createdAt: 1000,
      // shared with mobile — entry arrays
      verses: [["bg|2.13", { addrLabel: "BG 2.13", sanskrit: "s", transliteration: "t", translation: { en: "e" } }]],
      cites: [["track_1|0-500", { text: "quote" }]],
      // web-only
      cards: [["track_9", { trackId: "track_9", trackTitle: "Lecture" }]],
      researchQuestions: ["q1", "q2"],
      traceId: "trace-abc",
    }
    const meta = richFieldsToMeta(m as never)

    // Mobile's shared parser sees the shared fields, ignores the web ones.
    const mobileView = parseMeta(meta)
    expect(mobileView.verses["bg|2.13"]).toMatchObject({ addrLabel: "BG 2.13" })
    expect(mobileView.cites["track_1|0-500"]).toMatchObject({ text: "quote" })
    // web-only keys are NOT surfaced as canonical fields
    expect(Object.keys(mobileView.actions)).toHaveLength(0)

    // Web parser recovers everything, including the web-only namespace.
    const back = metaToRichFields(meta)
    expect(back.verses).toEqual(m.verses)
    expect(back.cites).toEqual(m.cites)
    expect(back.cards).toEqual(m.cards)
    expect(back.researchQuestions).toEqual(["q1", "q2"])
    expect(back.traceId).toBe("trace-abc")
  })

  it("carries settled attributes in the SHARED namespace, not the web one", () => {
    // Shared on purpose: a dialogue switched to Russian on the web must still
    // be answered in Russian when it is continued on the phone.
    const attributes = {
      reply_language: { value: "ru", label: "Русский", explicit: true },
    }
    const meta = richFieldsToMeta({
      id: "m1",
      role: "assistant",
      text: "Хорошо.",
      createdAt: 1000,
      attributes,
    } as never)

    expect(parseMeta(meta).attributes).toEqual(attributes)
    expect(metaToRichFields(meta).attributes).toEqual(attributes)
  })

  it("carries an attribute neither client understands", () => {
    // The keyed map's reason to exist: the server can add one and every client
    // keeps replaying it without a release.
    const meta = richFieldsToMeta({
      id: "m1",
      role: "assistant",
      text: "…",
      createdAt: 1000,
      attributes: { future_thing: { value: "42", label: "", explicit: false } },
    } as never)

    expect(parseMeta(meta).attributes).toEqual({
      future_thing: { value: "42", label: "", explicit: false },
    })
  })

  it("a card-less message serializes to the canonical empty envelope", () => {
    const meta = richFieldsToMeta({ id: "m", role: "user", text: "hi", createdAt: 1 } as never)
    expect(meta).toBe('{"_v":1,"data":{}}')
    expect(metaToRichFields(meta)).toEqual({})
  })
})

/* -------------------------------------------------------------------------- */
/*  2. diffOutbox — enqueue / idempotency / rename / delete                  */
/* -------------------------------------------------------------------------- */

describe("diffOutbox", () => {
  const now = 1_700_000_000_000

  it("enqueues a new session and its messages, then is idempotent", () => {
    const s = newState("web-A")
    const c = chat("s1", "Hello", now, [msg("m1", "user", "hi", now), msg("m2", "assistant", "yo", now + 1)])
    diffOutbox(s, [c], now)
    const ops = s.outbox.map((e) => `${e.collection}:${e.op}:${e.doc_id}`)
    expect(ops).toEqual(["chat_sessions:upsert:s1", "chat_messages:upsert:m1", "chat_messages:upsert:m2"])
    // Second diff with the same snapshot enqueues nothing new.
    const before = s.outbox.length
    diffOutbox(s, [c], now + 5)
    expect(s.outbox.length).toBe(before)
  })

  it("re-enqueues only the session when it is renamed", () => {
    const s = newState("web-A")
    const c = chat("s1", "Hello", now, [msg("m1", "user", "hi", now)])
    diffOutbox(s, [c], now)
    // Simulate the message already accepted by the server so it is not re-sent.
    s.docHlc[docKey("chat_messages", "m1")] = "x"
    s.outbox = s.outbox.filter((e) => e.collection !== "chat_messages")
    const renamed = chat("s1", "Renamed", now + 10, [msg("m1", "user", "hi", now)])
    diffOutbox(s, [renamed], now + 10)
    const ops = s.outbox.map((e) => `${e.collection}:${e.op}:${e.doc_id}`)
    expect(ops).toEqual(["chat_sessions:upsert:s1"])
  })

  it("skips the empty streaming placeholder", () => {
    const s = newState("web-A")
    const c = chat("s1", "H", now, [msg("m1", "user", "hi", now), msg("m2", "assistant", "", now + 1)])
    diffOutbox(s, [c], now)
    expect(s.outbox.some((e) => e.doc_id === "m2")).toBe(false)
  })

  it("tombstones a server-known session that vanished locally", () => {
    const s = newState("web-A")
    // Pretend s1 was previously synced.
    s.docHlc[docKey("chat_sessions", "s1")] = "hlc-s1"
    s.sessionSig["s1"] = "whatever"
    diffOutbox(s, [], now) // s1 gone from snapshot
    const del = s.outbox.find((e) => e.collection === "chat_sessions" && e.op === "delete")
    expect(del?.doc_id).toBe("s1")
  })

  it("does NOT tombstone a local-only session created and deleted before any sync", () => {
    const s = newState("web-A")
    const c = chat("s1", "H", now, [msg("m1", "user", "hi", now)])
    diffOutbox(s, [c], now) // enqueues create (never pushed — no docHlc)
    diffOutbox(s, [], now + 1) // deleted locally
    expect(s.outbox.some((e) => e.op === "delete")).toBe(false)
    // The pending create is dropped too — nothing to replicate.
    expect(s.outbox.some((e) => e.doc_id === "s1")).toBe(false)
    expect(s.outbox.some((e) => e.collection === "chat_messages")).toBe(false)
  })

  it("adopts a server-originated session as baseline without re-pushing it", () => {
    const s = newState("web-A")
    // Session already on the server (from a pull): docHlc set, no sessionSig.
    s.docHlc[docKey("chat_sessions", "s1")] = "hlc-s1"
    s.docHlc[docKey("chat_messages", "m1")] = "hlc-m1"
    const c = chat("s1", "FromServer", now, [msg("m1", "user", "hi", now)])
    diffOutbox(s, [c], now)
    expect(outboxEmpty(s)).toBe(true)
    expect(s.sessionSig["s1"]).toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  3. buildPushItems — ordering + base_hlc                                  */
/* -------------------------------------------------------------------------- */

describe("buildPushItems", () => {
  it("orders session-upserts before message-upserts before deletes, with base_hlc", () => {
    const s = newState("web-A")
    s.docHlc[docKey("chat_sessions", "s0")] = "base-s0"
    s.outbox = [
      { collection: "chat_messages", doc_id: "m1", op: "upsert", data: { session_id: "s1" }, hlc: "h2" },
      { collection: "chat_sessions", doc_id: "s1", op: "upsert", data: {}, hlc: "h1" },
      { collection: "chat_sessions", doc_id: "s0", op: "delete", data: null, hlc: "h3" },
    ]
    const items = buildPushItems(s)
    expect(items.map((i) => `${i.collection}:${i.op}`)).toEqual([
      "chat_sessions:upsert",
      "chat_messages:upsert",
      "chat_sessions:delete",
    ])
    expect(items.find((i) => i.doc_id === "s0")!.base_hlc).toBe("base-s0")
    expect(items.find((i) => i.doc_id === "s1")!.base_hlc).toBe("")
    // deletes carry no data
    expect((items.find((i) => i.op === "delete") as PushItem).data).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  4. applyPushResponse — applied + conflicts (LWW)                         */
/* -------------------------------------------------------------------------- */

describe("applyPushResponse", () => {
  function seedOutbox(hlc: string): SyncState {
    const s = newState("web-A")
    s.outbox = [{ collection: "chat_sessions", doc_id: "s1", op: "upsert", data: { title: "Local" }, hlc }]
    return s
  }

  it("clears an applied upsert and records its hlc as the base", () => {
    const s = seedOutbox("000000000000010:00000:web-A")
    const resp: PushResponse = { applied: [{ collection: "chat_sessions", doc_id: "s1" }], conflicts: [] }
    applyPushResponse(s, resp)
    expect(outboxEmpty(s)).toBe(true)
    expect(s.docHlc[docKey("chat_sessions", "s1")]).toBe("000000000000010:00000:web-A")
  })

  it("master wins: drops our stale write and returns the master to merge", () => {
    const s = seedOutbox("000000000000005:00000:web-A") // local older
    const resp: PushResponse = {
      applied: [],
      conflicts: [
        {
          collection: "chat_sessions",
          doc_id: "s1",
          master: {
            collection: "chat_sessions",
            doc_id: "s1",
            op: "upsert",
            data: { title: "Remote", updated_at: 20 },
            hlc: "000000000000009:00000:web-B", // newer
          },
        },
      ],
    }
    const plan: MergePlan = applyPushResponse(s, resp)
    expect(outboxEmpty(s)).toBe(true) // our write dropped
    expect(s.docHlc[docKey("chat_sessions", "s1")]).toBe("000000000000009:00000:web-B")
    expect(plan.sessionUpserts[0]).toMatchObject({ id: "s1", title: "Remote" })
  })

  it("local wins: keeps the write queued and advances its base to the master hlc", () => {
    const s = seedOutbox("000000000000030:00000:web-A") // local newer
    const resp: PushResponse = {
      applied: [],
      conflicts: [
        {
          collection: "chat_sessions",
          doc_id: "s1",
          master: {
            collection: "chat_sessions",
            doc_id: "s1",
            op: "upsert",
            data: { title: "Remote" },
            hlc: "000000000000009:00000:web-B",
          },
        },
      ],
    }
    const plan = applyPushResponse(s, resp)
    expect(outboxEmpty(s)).toBe(false) // still queued for re-push
    expect(s.docHlc[docKey("chat_sessions", "s1")]).toBe("000000000000009:00000:web-B")
    expect(plan.sessionUpserts).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/*  5. reducePull                                                            */
/* -------------------------------------------------------------------------- */

describe("reducePull", () => {
  it("advances docHlc and builds a merge plan; a delete clears docHlc", () => {
    const s = newState("web-A")
    const resp: PullResponse = {
      changes: [
        { collection: "chat_sessions", doc_id: "s1", op: "upsert", data: { title: "T", updated_at: 5 }, hlc: "h1" },
        {
          collection: "chat_messages",
          doc_id: "m1",
          op: "upsert",
          data: { session_id: "s1", role: "user", content: "hi", meta: '{"_v":1,"data":{}}', created_at: 5 },
          hlc: "h2",
        },
      ],
      cursor: 2,
      has_more: false,
    }
    const plan = reducePull(s, resp)
    expect(s.docHlc[docKey("chat_sessions", "s1")]).toBe("h1")
    expect(s.docHlc[docKey("chat_messages", "m1")]).toBe("h2")
    expect(plan.sessionUpserts[0]).toMatchObject({ id: "s1", title: "T" })
    expect(plan.messageUpserts[0]).toMatchObject({ sessionId: "s1" })
    expect(plan.messageUpserts[0].msg).toMatchObject({ id: "m1", role: "user", text: "hi" })

    const del: PullResponse = {
      changes: [{ collection: "chat_sessions", doc_id: "s1", op: "delete", hlc: "h3" }],
      cursor: 3,
      has_more: false,
    }
    const plan2 = reducePull(s, del)
    expect(s.docHlc[docKey("chat_sessions", "s1")]).toBeUndefined()
    expect(plan2.sessionDeletes).toEqual(["s1"])
  })
})

/* -------------------------------------------------------------------------- */
/*  6. Full two-device round-trip against a Go-semantics fake server         */
/* -------------------------------------------------------------------------- */

interface LogRow {
  server_seq: number
  collection: string
  doc_id: string
  op: "upsert" | "delete"
  data: unknown
  hlc: string
}

function fakeServer() {
  const log: LogRow[] = []
  const master = new Map<string, { op: "upsert" | "delete"; data: unknown; hlc: string; server_seq: number }>()
  let seq = 0
  return {
    push(_device: string, changes: PushItem[]): PushResponse {
      const applied: PushResponse["applied"] = []
      const conflicts: PushResponse["conflicts"] = []
      for (const it of changes) {
        const key = `${it.collection}:${it.doc_id}`
        const m = master.get(key)
        if (m && m.hlc === it.hlc) {
          applied.push({ collection: it.collection, doc_id: it.doc_id })
          continue
        }
        if (m && (it.base_hlc ?? "") !== m.hlc) {
          conflicts.push({
            collection: it.collection,
            doc_id: it.doc_id,
            master: { collection: it.collection, doc_id: it.doc_id, op: m.op, data: m.data, hlc: m.hlc, server_seq: m.server_seq },
          })
          continue
        }
        seq += 1
        const data = it.op === "upsert" ? it.data : undefined
        log.push({ server_seq: seq, collection: it.collection, doc_id: it.doc_id, op: it.op, data, hlc: it.hlc })
        master.set(key, { op: it.op, data, hlc: it.hlc, server_seq: seq })
        applied.push({ collection: it.collection, doc_id: it.doc_id })
      }
      return { applied, conflicts }
    },
    pull(cursor: number, limit: number): PullResponse {
      const all = log.filter((c) => c.server_seq > cursor)
      const page = all.slice(0, limit)
      return {
        changes: page.map((c) => ({ collection: c.collection, doc_id: c.doc_id, op: c.op, data: c.data, hlc: c.hlc, server_seq: c.server_seq })),
        cursor: page.length ? page[page.length - 1].server_seq : cursor,
        has_more: all.length > limit,
      }
    },
  }
}

/** Minimal history that applies a MergePlan the way mergeRemote does. */
function makeHistory() {
  const store = new Map<string, SnapshotChat>()
  function apply(plan: MergePlan) {
    for (const id of plan.sessionDeletes) store.delete(id)
    const touched = new Map<string, SnapshotChat>()
    for (const su of plan.sessionUpserts) {
      const prev = store.get(su.id)
      touched.set(su.id, {
        id: su.id,
        title: su.title,
        updatedAt: su.updatedAt,
        createdAt: prev?.createdAt ?? su.createdAt,
        messages: prev ? [...prev.messages] : [],
      })
    }
    for (const mu of plan.messageUpserts) {
      let c = touched.get(mu.sessionId) ?? store.get(mu.sessionId)
      if (!c) {
        c = { id: mu.sessionId, title: null, updatedAt: 0, createdAt: mu.msg.createdAt, messages: [] }
      } else if (!touched.has(mu.sessionId)) {
        c = { ...c, messages: [...c.messages] }
      }
      const byId = new Map(c.messages.map((m) => [m.id, m]))
      byId.set(mu.msg.id, mu.msg)
      c.messages = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      touched.set(mu.sessionId, c)
    }
    for (const [id, c] of touched) store.set(id, c)
  }
  return { store, apply, snapshot: () => [...store.values()] }
}

function runCycle(state: SyncState, server: ReturnType<typeof fakeServer>, history: ReturnType<typeof makeHistory>, now: number) {
  // diff FIRST (capture local deletes before the pull echo), then pull, then push
  diffOutbox(state, history.snapshot(), now)
  for (;;) {
    const resp = server.pull(state.cursor, 200)
    history.apply(reducePull(state, resp))
    state.cursor = resp.cursor
    if (!resp.has_more) break
  }
  adoptBaseline(state, history.snapshot())
  for (let round = 0; round < 3 && !outboxEmpty(state); round++) {
    const items = buildPushItems(state)
    if (!items.length) break
    const resp = server.push(state.deviceId, items)
    history.apply(applyPushResponse(state, resp))
    if (!resp.conflicts.length) break
  }
}

describe("two-device round-trip", () => {
  it("propagates a created chat with rich cards from device A to device B", () => {
    const server = fakeServer()
    const A = newState("web-A")
    const B = newState("web-B")
    const histA = makeHistory()
    const histB = makeHistory()

    // Device A creates a chat with a verse card.
    histA.store.set("s1", chat("s1", "On the soul", 1000, [
      msg("m1", "user", "what is the soul?", 1000),
      msg("m2", "assistant", "The soul is eternal [verse:bg/2.20|x]", 1001, {
        verses: [["bg|2.20", { addrLabel: "BG 2.20", sanskrit: "s", transliteration: "t", translation: { en: "eternal" } }]],
      }),
    ]))

    runCycle(A, server, histA, 2000)
    // A pushed everything.
    expect(outboxEmpty(A)).toBe(true)

    // Device B (fresh) pulls.
    runCycle(B, server, histB, 3000)
    const s1 = histB.store.get("s1")
    expect(s1?.title).toBe("On the soul")
    expect(s1?.messages.map((m) => m.id)).toEqual(["m1", "m2"])
    // Rich verse survived the round-trip and renders on B.
    const rich = metaToRichFields(richFieldsToMeta(s1!.messages[1] as never))
    expect(rich.verses).toEqual([["bg|2.20", { addrLabel: "BG 2.20", sanskrit: "s", transliteration: "t", translation: { en: "eternal" } }]])
  })

  it("propagates a delete from A to B", () => {
    const server = fakeServer()
    const A = newState("web-A")
    const B = newState("web-B")
    const histA = makeHistory()
    const histB = makeHistory()

    histA.store.set("s1", chat("s1", "Doomed", 1000, [msg("m1", "user", "hi", 1000)]))
    runCycle(A, server, histA, 2000)
    runCycle(B, server, histB, 2100)
    expect(histB.store.get("s1")).toBeDefined()

    // A deletes it.
    histA.store.delete("s1")
    runCycle(A, server, histA, 3000)
    // B pulls the tombstone.
    runCycle(B, server, histB, 3100)
    expect(histB.store.get("s1")).toBeUndefined()
  })

  it("resolves a concurrent rename by last-write-wins", () => {
    const server = fakeServer()
    const A = newState("web-A")
    const B = newState("web-B")
    const histA = makeHistory()
    const histB = makeHistory()

    histA.store.set("s1", chat("s1", "Orig", 1000, [msg("m1", "user", "hi", 1000)]))
    runCycle(A, server, histA, 2000)
    runCycle(B, server, histB, 2100) // B now has s1

    // Both rename concurrently; B's rename has the later HLC (later `now`).
    histA.store.set("s1", { ...histA.store.get("s1")!, title: "A-name", updatedAt: 5000 })
    histB.store.set("s1", { ...histB.store.get("s1")!, title: "B-name", updatedAt: 6000 })
    runCycle(A, server, histA, 5000) // A pushes first
    runCycle(B, server, histB, 6000) // B pushes later → B wins on the server

    // A syncs again and converges to B's newer title.
    runCycle(A, server, histA, 7000)
    expect(histA.store.get("s1")?.title).toBe("B-name")
    expect(histB.store.get("s1")?.title).toBe("B-name")
  })
})
