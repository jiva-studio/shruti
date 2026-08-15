import { describe, expect, it } from "vitest"
import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"
import { classifyIngestFailure } from "../classifyIngestFailure.js"

/**
 * Issue #1844: every rejected add to the personal library said "check your
 * connection", including three causes that have nothing to do with the user's
 * connection. This is the mapping that decides which sentence they get.
 */

class NetworkErrorLike extends Error {
  override name = "NetworkError"
}

describe("classifyIngestFailure", () => {
  it("names a request that never reached a server as offline", () => {
    expect(classifyIngestFailure(new NetworkErrorLike("POST /orchestrator/run"))).toBe("offline")
    expect(classifyIngestFailure(new TypeError("Failed to fetch"))).toBe("offline")
  })

  it("names a missing access token as an auth failure, not a connection one", () => {
    const err = new IngestGatewayError(0, "no access token for ingest request", "no_token")
    expect(classifyIngestFailure(err)).toBe("auth")
  })

  it("names our own 15 s cap as a timeout", () => {
    expect(
      classifyIngestFailure(new IngestGatewayError(0, "ingest api timed out", "timeout"))
    ).toBe("timeout")
  })

  it.each([401, 403])("names a rejected token (%i) as an auth failure", (status) => {
    expect(
      classifyIngestFailure(new IngestGatewayError(status, `ingest api responded ${status}`))
    ).toBe("auth")
  })

  it.each([400, 404, 429, 500, 503])(
    "names any other orchestrator status (%i) as server",
    (status) => {
      expect(
        classifyIngestFailure(new IngestGatewayError(status, `ingest api responded ${status}`))
      ).toBe("server")
    }
  )

  it("names failover's thrown HTTP 502 as server, not offline", () => {
    expect(classifyIngestFailure(new Error("HTTP 502"))).toBe("server")
  })

  it("reads the status back out of a thrown HTTP 401", () => {
    expect(classifyIngestFailure(new Error("HTTP 401"))).toBe("auth")
  })

  it("falls back to server for anything unrecognised", () => {
    expect(classifyIngestFailure(new Error("boom"))).toBe("server")
    expect(classifyIngestFailure("boom")).toBe("server")
  })
})
