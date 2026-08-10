import http from "node:http"
import type { AddressInfo } from "node:net"
import type { Page } from "@playwright/test"

/**
 * A real streaming chat endpoint, for the answers a route cannot give.
 *
 * `page.route` fulfils a request in one piece: it cannot send headers, write a
 * frame, and then go quiet. So the one thing the stall timeout is about — a
 * connection that was accepted, started answering, and then stopped without
 * closing — is not expressible as a route at all. This is a socket that can.
 *
 * A spec points a region's `chatBaseUrl` at `origin` (the same technique
 * `region-failover` uses for its fake edges) and calls `allowSseServer` so the
 * network guard lets the request through instead of aborting it.
 */
export interface SseServerOptions {
  /**
   * Frames to write, in order — built with `delta()` / `done()` / `action()`
   * from `chat-mock.ts`, so the wire format lives in one place. The blank line
   * that terminates each frame is added here.
   */
  frames: string[]
  /**
   * Stop writing after this many frames and hold the connection open forever.
   * Omit to write every frame and close normally.
   */
  stallAfter?: number
  /** Delay between frames, ms. */
  frameDelayMs?: number
}

export interface SseServer {
  /** e.g. `http://127.0.0.1:41234` — what a region's chatBaseUrl points at. */
  origin: string
  /** How many chat requests the server accepted. */
  requests(): number
  close(): Promise<void>
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
}

export async function startSseServer(options: SseServerOptions): Promise<SseServer> {
  const { frames, stallAfter, frameDelayMs = 50 } = options
  let accepted = 0
  const open = new Set<http.ServerResponse>()

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    accepted++
    res.writeHead(200, {
      ...CORS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    open.add(res)
    res.on("close", () => open.delete(res))

    const limit = stallAfter ?? frames.length
    void (async () => {
      for (let i = 0; i < Math.min(limit, frames.length); i++) {
        if (res.writableEnded) return
        res.write(`${frames[i]}\n\n`)
        await new Promise((r) => setTimeout(r, frameDelayMs))
      }
      // Closing is what `stallAfter` opts out of. Keyed on the option, NOT on
      // whether the limit happened to reach the end of the frame list —
      // `stallAfter: frames.length` is a stall too, and reading it as "wrote
      // everything, so close" turns a stall test into a normal-stream test
      // that passes in a fraction of the time and proves nothing.
      if (stallAfter === undefined && !res.writableEnded) res.end()
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        // A stalled response holds the server open, so drop them explicitly.
        for (const res of open) res.destroy()
        open.clear()
        server.close(() => resolve())
      }),
  }
}

/**
 * Let requests to this server past the network guard, which otherwise aborts
 * everything it was not asked about. A page route beats the context-level
 * guard, and `continue()` means the request really reaches the socket.
 */
export async function allowSseServer(page: Page, server: SseServer): Promise<void> {
  await page.route(`${server.origin}/**`, (route) => void route.continue())
}
