import { describe, it, expect, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import {
  createRegionFailoverClient,
  distinctByBaseUrl,
  isReplayableAuthPath,
  withCrossServerReplay,
} from "../regionFailover.js"

// The real topology: `ru` is a thin edge that proxies to the same backend
// `global` and `legacy` share, so two of the three auth base URLs are equal.
const GLOBAL = { id: "global", authBaseUrl: "https://api.test/auth" } as CdnServer
const RU = { id: "ru", authBaseUrl: "https://ru.test/auth" } as CdnServer
const LEGACY = { id: "legacy", authBaseUrl: "https://api.test/auth" } as CdnServer
const REGIONS = [GLOBAL, RU, LEGACY] as readonly CdnServer[]

const authUrl = (s: CdnServer): string => s.authBaseUrl

const ok = (): Response => new Response("{}", { status: 200 })
const unavailable = (): Response => new Response("", { status: 503 })

describe("distinctByBaseUrl", () => {
  it("keeps one region per resolved base url, in declared order", () => {
    expect(distinctByBaseUrl(REGIONS, authUrl, "global").map((s) => s.id)).toEqual(["global", "ru"])
  })

  it("keeps the preferred region even when an earlier one resolves to the same url", () => {
    // Dropping it would leave kit unable to match the preferred id, which is
    // what drives outage tracking and fallback promotion.
    expect(distinctByBaseUrl(REGIONS, authUrl, "legacy").map((s) => s.id)).toEqual(["legacy", "ru"])
  })

  it("keeps every region when the urls all differ", () => {
    const distinct = [
      GLOBAL,
      RU,
      { ...LEGACY, authBaseUrl: "https://old.test/auth" },
    ] as CdnServer[]
    expect(distinctByBaseUrl(distinct, authUrl, "global")).toHaveLength(3)
  })
})

describe("isReplayableAuthPath", () => {
  it("allows the device-keyed mint and the social upserts", () => {
    expect(isReplayableAuthPath("/anonymous")).toBe(true)
    expect(isReplayableAuthPath("/signin/google")).toBe(true)
    expect(isReplayableAuthPath("/signin/apple")).toBe(true)
  })

  it("withholds refresh, the single-use email code and the destructive calls", () => {
    expect(isReplayableAuthPath("/refresh")).toBe(false)
    expect(isReplayableAuthPath("/signin/email/request")).toBe(false)
    expect(isReplayableAuthPath("/signin/email/verify")).toBe(false)
    expect(isReplayableAuthPath("/signout")).toBe(false)
    expect(isReplayableAuthPath("/account/delete")).toBe(false)
  })
})

describe("withCrossServerReplay", () => {
  it("flags a matching path and leaves the rest of the init alone", async () => {
    const request = vi.fn(async () => ok())
    const wrapped = withCrossServerReplay(request, (p) => p === "/anonymous")

    await wrapped("/anonymous", { method: "POST", body: "{}" })
    expect(request).toHaveBeenCalledWith("/anonymous", {
      method: "POST",
      body: "{}",
      crossServerReplay: true,
    })
  })

  it("passes a non-matching path through untouched, so a GET keeps its default", async () => {
    const request = vi.fn(async () => ok())
    const wrapped = withCrossServerReplay(request, (p) => p === "/anonymous")

    const init = { method: "GET" }
    await wrapped("/me", init)
    // Not `crossServerReplay: false` — that would PIN the read to one edge.
    expect(request).toHaveBeenCalledWith("/me", init)
  })
})

describe("createRegionFailoverClient", () => {
  const client = (fetchImpl: typeof fetch, preferredId = "ru") =>
    createRegionFailoverClient({
      getServers: () => REGIONS,
      getPreferredId: () => preferredId,
      pickBaseUrl: authUrl,
      fetchImpl,
    })

  it("mints the anonymous identity on another edge when the preferred one is dead", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://ru.test/") ? unavailable() : ok()
    ) as unknown as typeof fetch
    const request = withCrossServerReplay(
      (path, init) => client(fetchImpl).request(path, init),
      isReplayableAuthPath
    )

    const response = await request("/anonymous", { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(vi.mocked(fetchImpl).mock.calls.map((c) => String(c[0]))).toEqual([
      "https://ru.test/auth/anonymous",
      "https://api.test/auth/anonymous",
    ])
  })

  it("does not replay a refresh — a consumed token elsewhere is a sign-out", async () => {
    const fetchImpl = vi.fn(async () => unavailable()) as unknown as typeof fetch
    const request = withCrossServerReplay(
      (path, init) => client(fetchImpl).request(path, init),
      isReplayableAuthPath
    )

    await expect(request("/refresh", { method: "POST", body: "{}" })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("asks each distinct host once — three regions, two doors", async () => {
    const fetchImpl = vi.fn(async () => unavailable()) as unknown as typeof fetch
    const request = withCrossServerReplay(
      (path, init) => client(fetchImpl).request(path, init),
      () => true
    )

    await expect(request("/search", { method: "POST", body: "{}" })).rejects.toThrow()
    // Without the collapse this was three requests at one failing backend.
    expect(vi.mocked(fetchImpl).mock.calls.map((c) => String(c[0]))).toEqual([
      "https://ru.test/auth/search",
      "https://api.test/auth/search",
    ])
  })
})
