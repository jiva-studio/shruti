import type { BrowserContext } from "@playwright/test"

/**
 * Offline stand-in for the `profile` device↔server sync service.
 *
 * The sync engine drives `POST {profileBaseUrl}/profile/sync/{pull,push,cursor}`
 * on a timer, and now does so for anonymous users too — so every spec has a
 * sync loop running behind it. Nothing intercepted those routes, so they went
 * to the production edge; once the mocked region points them at a dead loopback
 * port they would instead fail and retry. These handlers give the engine the
 * deterministic local answer it needs: nothing to pull, every push accepted,
 * cursor acknowledged.
 *
 * Registered at CONTEXT level so a spec's own `page.route` — which Playwright
 * matches first — can still override any of them.
 *
 * The wire shapes mirror `@lib/contracts/sync` and the Go handlers in
 * `modules/services/profile/internal/handler/sync.go`. The e2e package has no
 * path aliases into the app, so the two structural bits are restated here.
 */

/** One row of `PushRequest.changes` — only the ref fields matter to the mock. */
interface PushItemRef {
  readonly collection: string
  readonly doc_id: string
}

export async function installProfileSyncMock(context: BrowserContext): Promise<void> {
  // Nothing on the server: an empty page at the cursor the client asked for.
  await context.route("**/profile/sync/pull", (route) => {
    const cursor = readJson<{ cursor?: number }>(route.request().postData())?.cursor ?? 0
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ changes: [], cursor, has_more: false }),
    })
  })

  // Accept every pushed row. Echoing the refs back under `applied` is what lets
  // the engine mark its outbox rows sent; an empty `applied` would leave them
  // pending and re-pushed on every round.
  await context.route("**/profile/sync/push", (route) => {
    const req = readJson<{ changes?: readonly PushItemRef[] }>(route.request().postData())
    const applied = (req?.changes ?? []).map((c) => ({
      collection: c.collection,
      doc_id: c.doc_id,
    }))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ applied, conflicts: [] }),
    })
  })

  // The cursor ack answers `{"ok":true}`; the client reads no body from it.
  await context.route("**/profile/sync/cursor", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    })
  )
}

function readJson<T>(body: string | null): T | undefined {
  if (!body) return undefined
  try {
    return JSON.parse(body) as T
  } catch {
    return undefined
  }
}
