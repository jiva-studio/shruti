import fs from "fs"
import type { BrowserContext, TestInfo } from "@playwright/test"

/**
 * Outbound-traffic guard for the offline suite.
 *
 * The suite must never touch a real backend. It used to: the mocked
 * `config.json` carried no `regions` block, so the app kept the compiled-in
 * `SERVERS` list and every unmocked call — `POST /auth/anonymous` above all —
 * landed on the production origin, minting a real anonymous account per spec.
 *
 * This installs a **last-resort** context route: page-level routes registered
 * by `bootstrap.ts` / a spec are matched first, so anything that reaches here
 * is a request that would genuinely have left the machine. Every such request
 * is aborted, and one that targets a production host also fails the test.
 *
 * Set `E2E_NET_LOG=<file>` to additionally append a JSONL record of every
 * blocked attempt — that is how the before/after leak measurement is taken.
 */

/** Hosts that are, or front, real infrastructure. A hit here fails the test. */
const PRODUCTION_HOST_SUFFIXES = [
  // Caddy edges (global + russia), reached as <ip-dashed>.sslip.io.
  "sslip.io",
  // Bunny CDN — the `global` region's content origin.
  "b-cdn.net",
  // Yandex Object Storage — the `russia` region's content origin.
  "yandexcloud.net",
  // The retired S3 bucket, still the `legacy` region's content origin.
  "amazonaws.com",
  // The public web app share links resolve to.
  "shruti.app",
]

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

function isLocal(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")
}

function isProduction(hostname: string): boolean {
  return PRODUCTION_HOST_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))
}

export interface NetworkGuard {
  /** Throws when the test reached a production host. Called on teardown. */
  assertNoProductionTraffic(): void
}

export async function installNetworkGuard(
  context: BrowserContext,
  testInfo: TestInfo
): Promise<NetworkGuard> {
  const spec = `${testInfo.titlePath.join(" › ")}`
  const file = testInfo.file
  const logPath = process.env.E2E_NET_LOG
  const violations: string[] = []

  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = request.url()
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      await route.fallback()
      return
    }
    // Loopback (the dev server + the region sink) and non-http schemes are
    // never outbound; let the normal handling run.
    if (!hostname || isLocal(hostname)) {
      await route.fallback()
      return
    }

    const production = isProduction(hostname)
    if (logPath) {
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({ host: hostname, method: request.method(), url, production, spec, file })}\n`
      )
    }
    if (production) violations.push(`${request.method()} ${url}`)
    await route.abort("blockedbyclient")
  })

  return {
    assertNoProductionTraffic(): void {
      if (violations.length === 0) return
      const list = [...new Set(violations)].map((v) => `    - ${v}`).join("\n")
      throw new Error(
        `Network guard: this spec sent ${violations.length} request(s) to a PRODUCTION host.\n` +
          `  spec: ${spec}\n` +
          `  file: ${file}\n` +
          `  blocked:\n${list}\n` +
          `  The offline suite must stay offline. Either mock the endpoint on the page ` +
          `(see support/chat-mock.ts) or route it through the local sink region published ` +
          `by interceptContent() in support/bootstrap.ts.`
      )
    },
  }
}
