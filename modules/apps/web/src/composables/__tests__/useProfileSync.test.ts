import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { SnapshotChat } from "../sync/profileSyncCore"
import { useProfileSync } from "../useProfileSync"

const session = ref<{ userId: string } | null>(null)
const ensureToken = vi.fn<() => Promise<string>>()

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    session,
    signedIn: computed(() => session.value !== null),
    hydrate: () => undefined,
    ensureToken,
  }),
}))

const PULL_WITH_A_CHAT = {
  changes: [
    {
      collection: "chat_sessions",
      doc_id: "s-remote",
      op: "upsert",
      data: { title: "Remote", updated_at: 5 },
      hlc: "h1",
    },
  ],
  cursor: 7,
  has_more: false,
}

const LOCAL_CHAT: SnapshotChat = {
  id: "s-local",
  title: "Local",
  updatedAt: 10,
  createdAt: 10,
  messages: [{ id: "m1", role: "user", text: "hi", createdAt: 10 } as SnapshotChat["messages"][0]],
}

function tokenFor(user: string): string {
  return `token-of-${user}`
}

function sentTokens(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const headers = (init as RequestInit).headers as Record<string, string>
    return headers.Authorization ?? ""
  })
}

function sentPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("useProfileSync owner check", () => {
  beforeEach(() => {
    session.value = { userId: "A" }
    ensureToken.mockReset()
    ensureToken.mockImplementation(async () => tokenFor(session.value?.userId ?? "none"))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("drops a pull that lands after the account changed", async () => {
    let releasePull: (r: Response) => void = () => undefined
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith("/pull")) releasePull = resolve
          else resolve(json({ accepted: [], conflicts: [] }))
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const merge = vi.fn()
    const sync = useProfileSync({
      profileBaseUrl: "https://profile.test",
      storageKey: "t",
      snapshot: () => [LOCAL_CHAT],
      merge,
    })

    const cycle = sync.sync()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    session.value = { userId: "B" }
    releasePull(json(PULL_WITH_A_CHAT))
    await cycle

    expect(merge).not.toHaveBeenCalled()
    expect(sentPaths(fetchMock)).toEqual(["/profile/sync/pull"])
  })

  it("never pushes account A's outbox with account B's token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pull")) return json({ changes: [], cursor: 0, has_more: false })
      if (url.endsWith("/cursor")) {
        // The account switches while the cycle is between its ack and its push.
        session.value = { userId: "B" }
        return json({})
      }
      return json({ accepted: [], conflicts: [] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const sync = useProfileSync({
      profileBaseUrl: "https://profile.test",
      storageKey: "t",
      snapshot: () => [LOCAL_CHAT],
      merge: vi.fn(),
    })

    await sync.sync()
    await vi.waitFor(() => expect(sync.syncing.value).toBe(false))

    // A's cycle stops after its ack; what follows is B's own cycle, which
    // starts with B's pull.
    const paths = sentPaths(fetchMock)
    const tokens = sentTokens(fetchMock)
    expect(paths.slice(0, 3)).toEqual([
      "/profile/sync/pull",
      "/profile/sync/cursor",
      "/profile/sync/pull",
    ])
    expect(tokens.slice(0, 2)).toEqual([`Bearer ${tokenFor("A")}`, `Bearer ${tokenFor("A")}`])
    expect(tokens.slice(2).every((t) => t === `Bearer ${tokenFor("B")}`)).toBe(true)
  })

  it("drops a push response that lands after the account changed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pull")) return json({ changes: [], cursor: 0, has_more: false })
      if (url.endsWith("/cursor")) return json({})
      session.value = { userId: "B" }
      return json({
        applied: [],
        conflicts: [
          {
            collection: "chat_sessions",
            doc_id: "s-local",
            master: {
              collection: "chat_sessions",
              doc_id: "s-local",
              op: "upsert",
              data: { title: "Remote", updated_at: 20 },
              hlc: "999999999999999:00000:web-B",
            },
          },
        ],
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    const merge = vi.fn()
    const sync = useProfileSync({
      profileBaseUrl: "https://profile.test",
      storageKey: "t",
      snapshot: () => [LOCAL_CHAT],
      merge,
    })

    await sync.sync()

    expect(sentPaths(fetchMock)).toContain("/profile/sync/push")
    expect(merge).not.toHaveBeenCalled()
  })

  it("refuses a token minted for another account mid-request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pull")) return json({ changes: [], cursor: 0, has_more: false })
      return json({ accepted: [], conflicts: [] })
    })
    vi.stubGlobal("fetch", fetchMock)
    ensureToken.mockImplementation(async () => {
      // The third token request is the push: the account changes while the
      // token is being fetched.
      if (ensureToken.mock.calls.length === 3) session.value = { userId: "B" }
      return tokenFor(session.value?.userId ?? "none")
    })
    const sync = useProfileSync({
      profileBaseUrl: "https://profile.test",
      storageKey: "t",
      snapshot: () => [LOCAL_CHAT],
      merge: vi.fn(),
    })

    await sync.sync()

    expect(sentTokens(fetchMock)).not.toContain(`Bearer ${tokenFor("B")}`)
  })

  it("pushes the outbox when the account stays the same", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pull")) return json({ changes: [], cursor: 0, has_more: false })
      return json({ accepted: [], conflicts: [] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const sync = useProfileSync({
      profileBaseUrl: "https://profile.test",
      storageKey: "t",
      snapshot: () => [LOCAL_CHAT],
      merge: vi.fn(),
    })

    await sync.sync()

    expect(sentPaths(fetchMock)).toEqual([
      "/profile/sync/pull",
      "/profile/sync/cursor",
      "/profile/sync/push",
    ])
    expect(new Set(sentTokens(fetchMock))).toEqual(new Set([`Bearer ${tokenFor("A")}`]))
  })
})
