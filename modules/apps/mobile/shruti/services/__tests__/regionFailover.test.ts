import { describe, it, expect, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import {
  createRegionFailoverClient,
  distinctByBaseUrl,
  isReplayableAuthPath,
  servesBaseUrl,
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

// The ingest control plane is the door not every region publishes:
// `orchestratorBaseUrl` is optional (a config.json predating the ingest API
// omits it, and `isValidRegion` deliberately does not require it), so a mixed
// list is a supported state.
const ORCHESTRATOR_REGIONS = [
  { id: "ru", orchestratorBaseUrl: "https://ru.test" },
  { id: "global" },
  { id: "legacy", orchestratorBaseUrl: "https://api.test" },
] as unknown as readonly CdnServer[]

const orchestratorUrl = (s: CdnServer): string => s.orchestratorBaseUrl ?? ""

describe("servesBaseUrl", () => {
  it("accepts an absolute http(s) base and rejects what the WebView resolves locally", () => {
    expect(servesBaseUrl("https://api.test")).toBe(true)
    expect(servesBaseUrl("http://localhost:11080")).toBe(true)
    // Everything below leaves `joinUrl` returning a PATH, which the WebView
    // resolves against `capacitor://localhost`.
    expect(servesBaseUrl("")).toBe(false)
    expect(servesBaseUrl("/orchestrator")).toBe(false)
    expect(servesBaseUrl("api.test")).toBe(false)
  })
})

describe("createRegionFailoverClient — regions that do not serve the door", () => {
  /** What a WebView does with a scheme-less URL: resolves it against its own
   *  origin and answers 404 — which kit reads as the backend's verdict and
   *  returns, so a job that exists is reported "not found". */
  function webView(fetchImpl: (url: string) => Response): typeof fetch {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      return u.startsWith("http") ? fetchImpl(u) : new Response("", { status: 404 })
    }) as unknown as typeof fetch
  }

  it("skips a region without a base url instead of asking the WebView origin", async () => {
    const seen: string[] = []
    const fetchImpl = webView((u) => {
      seen.push(u)
      return u.startsWith("https://ru.test/") ? unavailable() : ok()
    })
    const client = createRegionFailoverClient({
      getServers: () => ORCHESTRATOR_REGIONS,
      getPreferredId: () => "ru",
      pickBaseUrl: orchestratorUrl,
      fetchImpl,
    })

    const response = await client.request("/orchestrator/ingest/job-1")

    // The preferred edge 502s, `global` cannot serve this door at all, and the
    // walk carries on to `legacy` rather than stopping at a local 404.
    expect(response.status).toBe(200)
    expect(seen).toEqual([
      "https://ru.test/orchestrator/ingest/job-1",
      "https://api.test/orchestrator/ingest/job-1",
    ])
  })

  it("surfaces a transient error when no region serves the door at all", async () => {
    const fetchImpl = webView(() => ok())
    const client = createRegionFailoverClient({
      getServers: () => [{ id: "ru" }, { id: "global" }] as unknown as readonly CdnServer[],
      getPreferredId: () => "ru",
      pickBaseUrl: orchestratorUrl,
      fetchImpl,
    })

    // A throw lands where a dead edge lands, so the UI offers a retry. A 404
    // would tell the user their job does not exist.
    await expect(client.request("/orchestrator/ingest/job-1")).rejects.toThrow(/no region serves/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(client.resolveUrl("/orchestrator/ingest/job-1")).toBe("")
  })
})
