import { beforeEach, describe, expect, it, vi } from "vitest"

const ctx = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(async () => "fresh-token"),
  setActiveServerById: vi.fn(),
  getId: vi.fn(async () => ({ identifier: "device-1" })),
}))

vi.mock("@capacitor/device", () => ({ Device: { getId: ctx.getId } }))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: { value: { id: "global" } },
    setActiveServerById: ctx.setActiveServerById,
    auth: {
      refreshAccessToken: ctx.refreshAccessToken,
      onSessionChange: () => () => {},
    },
  }),
}))

const REGION = {
  id: "global",
  name: "Global",
  urlTemplate: "https://cdn.test/{path}",
  shareAudioUrl: "https://chat.test/share/audio",
  shareVideoUrl: "https://chat.test/share/video",
  authBaseUrl: "https://auth.test",
  chatBaseUrl: "https://chat.test",
  profileBaseUrl: "https://profile.test",
  orchestratorBaseUrl: "https://orchestrator.test",
  discoveryBaseUrl: "https://discovery.test",
}

const regions = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("@shruti/services/regionsRegistry.js", () => ({ getRegions: () => regions.list }))

import { createServiceRequests } from "../serviceRequests.js"

/** Answers 401 the first `unauthorized` times, then 200. Records every URL
 *  and the bearer it was sent with. */
function stubFetch(unauthorized: number) {
  const urls: string[] = []
  const bearers: (string | null)[] = []
  let left = unauthorized
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    bearers.push(new Headers(init?.headers).get("Authorization"))
    if (left > 0) {
      left--
      return new Response("", { status: 401 })
    }
    return new Response("{}", { status: 200 })
  })
  globalThis.fetch = fn as never
  return { urls, bearers }
}

const AUTHED: RequestInit = { headers: { Authorization: "Bearer stale" } }

beforeEach(() => {
  vi.clearAllMocks()
  regions.list = [REGION]
})

describe("routing", () => {
  it("sends each service to its own door", async () => {
    const { urls } = stubFetch(0)
    const s = createServiceRequests()
    await s.authRequest("/refresh")
    await s.chatRequest("/title")
    await s.profileRequest("/profile/sync/pull")
    await s.ingestRequest("/orchestrator/ingest")
    await s.discoveryRequest("/discovery/search")
    expect(urls).toEqual([
      "https://auth.test/refresh",
      "https://chat.test/title",
      "https://profile.test/profile/sync/pull",
      "https://orchestrator.test/orchestrator/ingest",
      "https://discovery.test/discovery/search",
    ])
  })

  it("sends discovery behind chat when the region predates the field", async () => {
    const { discoveryBaseUrl, ...older } = REGION
    void discoveryBaseUrl
    regions.list = [older]
    const { urls } = stubFetch(0)
    await createServiceRequests().discoveryRequest("/discovery/search")
    expect(urls).toEqual(["https://chat.test/discovery/search"])
  })

  it("refuses to call a door no region serves rather than inventing a local one", async () => {
    const { profileBaseUrl, ...older } = REGION
    void profileBaseUrl
    regions.list = [older]
    stubFetch(0)
    await expect(createServiceRequests().profileRequest("/profile/sync/pull")).rejects.toThrow()
  })
})

describe("the 401 interceptor", () => {
  it("refreshes once and replays the request with the fresh bearer", async () => {
    const { urls, bearers } = stubFetch(1)
    const response = await createServiceRequests().chatRequest("/title", AUTHED)
    expect(ctx.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(urls).toEqual(["https://chat.test/title", "https://chat.test/title"])
    expect(bearers).toEqual(["Bearer stale", "Bearer fresh-token"])
    expect(response.status).toBe(200)
  })

  it("leaves a 401 that carries no bearer alone — it is not about our token", async () => {
    const { urls } = stubFetch(1)
    const response = await createServiceRequests().chatRequest("/title")
    expect(ctx.refreshAccessToken).not.toHaveBeenCalled()
    expect(urls).toHaveLength(1)
    expect(response.status).toBe(401)
  })

  // The refresh state lives on the shared factory: one interceptor per
  // composition root, not one per client.
  it("collapses simultaneous 401s across services into a single refresh", async () => {
    stubFetch(3)
    const s = createServiceRequests()
    await Promise.all([
      s.chatRequest("/title", AUTHED),
      s.profileRequest("/profile/sync/pull", AUTHED),
      s.discoveryRequest("/discovery/search", AUTHED),
    ])
    expect(ctx.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it("never refreshes on a 401 from the auth service itself", async () => {
    const { urls } = stubFetch(1)
    const response = await createServiceRequests().authRequest("/refresh", AUTHED)
    expect(ctx.refreshAccessToken).not.toHaveBeenCalled()
    expect(urls).toHaveLength(1)
    expect(response.status).toBe(401)
  })

  it("gives up rather than looping when the session is unrecoverable", async () => {
    ctx.refreshAccessToken.mockResolvedValueOnce(null as never)
    const { urls } = stubFetch(99)
    const response = await createServiceRequests().chatRequest("/title", AUTHED)
    expect(ctx.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
    expect(urls).toHaveLength(1)
  })
})

describe("the device id", () => {
  it("is asked for once and reused", async () => {
    stubFetch(0)
    const s = createServiceRequests()
    expect(await Promise.all([s.getDeviceId(), s.getDeviceId(), s.getDeviceId()])).toEqual([
      "device-1",
      "device-1",
      "device-1",
    ])
    expect(ctx.getId).toHaveBeenCalledTimes(1)
  })
})
