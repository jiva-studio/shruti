import { describe, expect, it, vi } from "vitest"
import { createHttpSyncClient, SyncGatewayError } from "../syncClient.js"

function client(request: ReturnType<typeof vi.fn>, token: string | null = "tok") {
  return createHttpSyncClient({
    getAccessToken: async () => token,
    request: request as unknown as (path: string, init?: RequestInit) => Promise<Response>,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("createHttpSyncClient", () => {
  it("posts the pull request to the profile service and returns the page", async () => {
    const request = vi.fn().mockResolvedValue(json({ changes: [], cursor: 42, has_more: false }))

    const page = await client(request).pull({ cursor: 7, limit: 100 })

    expect(page).toEqual({ changes: [], cursor: 42, has_more: false })
    const [path, init] = request.mock.calls[0] as [string, RequestInit]
    expect(path).toBe("/profile/sync/pull")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ cursor: 7, limit: 100 })
  })

  it("carries the bearer token on every call", async () => {
    const request = vi.fn().mockResolvedValue(json({ applied: [], conflicts: [] }))

    await client(request, "jwt-123").push({ device_id: "d1", changes: [] })

    const init = request.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
  })

  it("returns what the server applied and rejected", async () => {
    const body = {
      applied: [{ collection: "notes", doc_id: "n1" }],
      conflicts: [{ collection: "notes", doc_id: "n2" }],
    }
    const result = await client(vi.fn().mockResolvedValue(json(body))).push({
      device_id: "d1",
      changes: [],
    })
    expect(result).toEqual(body)
  })

  it("acks the cursor without reading a body", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    await expect(
      client(request).ackCursor({ device_id: "d1", acked_seq: 9 })
    ).resolves.toBeUndefined()
    expect(request.mock.calls[0]![0]).toBe("/profile/sync/cursor")
  })

  it("refuses to call without a session rather than sending an empty bearer", async () => {
    const request = vi.fn()

    await expect(client(request, null).pull({ cursor: 0, limit: 1 })).rejects.toMatchObject({
      name: "SyncGatewayError",
      status: 0,
      code: "unauthenticated",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("surfaces the server's error envelope", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        json(
          { ok: false, error: { code: "cursor_too_old", message: "compacted", details: { x: 1 } } },
          409
        )
      )

    const error = await client(request)
      .pull({ cursor: 1, limit: 10 })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SyncGatewayError)
    expect(error).toMatchObject({ status: 409, code: "cursor_too_old", details: { x: 1 } })
    expect((error as Error).message).toContain("compacted")
  })

  it("falls back to the body text when the failure is not an envelope", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("gateway down", { status: 502, statusText: "Bad Gateway" }))

    const error = await client(request)
      .push({ device_id: "d1", changes: [] })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 502, code: undefined })
    expect((error as Error).message).toContain("gateway down")
  })

  it("names the operation that failed", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 500 }))

    await expect(client(request).ackCursor({ device_id: "d1", acked_seq: 1 })).rejects.toThrow(
      /sync cursor failed: 500/
    )
  })
})
