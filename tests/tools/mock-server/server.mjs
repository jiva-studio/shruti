#!/usr/bin/env node
import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.MOCK_PORT ?? 11090)
const FIXTURES = new URL("../../e2e/mobile/fixtures/", import.meta.url)
// Audio is silence either way; the short one exists so a track can end inside
// a test. Opt in per run through POST /__audio, default stays the long one.
const AUDIO_FIXTURES = { default: "silent.mp3", short: "silent-3s.mp3" }

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

const state = {
  requests: [],
  unknown: [],
  changes: [],
  cursor: 0,
  audio: "default",
  // The real service keys an anonymous user by the device id the app presents,
  // so the same device coming back gets the same user. Modelled here because a
  // reinstall test has no other way to see that happen.
  identities: {},
  mints: [],
  user: { userId: "mock-user", email: null, name: null, pictureUrl: null, anonymous: true, tier: "free" },
}

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.mock`
}

function tokens(userId = state.user.userId) {
  return {
    accessToken: jwt({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      quota_id: `quota-${userId}`,
      tier: state.user.tier,
      tier_expires_at: 0,
      anonymous: state.user.anonymous,
    }),
    refreshToken: "mock-refresh",
    userId,
    anonymous: state.user.anonymous,
  }
}

/** One anonymous user per device, minted on first sight. */
function anonymousUserId(deviceId) {
  state.identities[deviceId] ??= `anon-${Object.keys(state.identities).length + 1}`
  return state.identities[deviceId]
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return null
  }
}

const routes = [
  // Test control plane.
  ["GET", /^\/__requests$/, (req, res) => json(res, state.requests)],
  ["GET", /^\/__unknown$/, (req, res) => json(res, state.unknown)],
  ["GET", /^\/__mints$/, (req, res) => json(res, state.mints)],
  [
    "POST",
    /^\/__seed$/,
    async (req, res) => {
      const body = await readBody(req)
      state.changes = body?.changes ?? []
      state.cursor = body?.cursor ?? state.changes.length
      if (body?.user) Object.assign(state.user, body.user)
      json(res, { ok: true, changes: state.changes.length })
    },
  ],
  [
    "POST",
    /^\/__audio$/,
    async (req, res) => {
      const body = await readBody(req)
      const fixture = body?.fixture ?? "default"
      if (!AUDIO_FIXTURES[fixture]) return json(res, { error: "unknown fixture", fixture }, 400)
      state.audio = fixture
      json(res, { ok: true, fixture })
    },
  ],
  ["POST", /^\/__reset$/, (req, res) => {
    state.requests = []
    state.unknown = []
    state.changes = []
    state.cursor = 0
    state.audio = "default"
    state.identities = {}
    state.mints = []
    json(res, { ok: true })
  }],

  // auth
  [
    "POST",
    /^\/auth\/anonymous$/,
    async (req, res) => {
      const body = await readBody(req)
      const deviceId = typeof body?.deviceId === "string" ? body.deviceId : ""
      const userId = anonymousUserId(deviceId)
      state.mints.push({ deviceId, platform: body?.platform ?? null, userId })
      json(res, tokens(userId))
    },
  ],
  ["POST", /^\/auth\/refresh$/, (req, res) => json(res, tokens())],
  ["GET", /^\/auth\/me$/, (req, res) => json(res, state.user)],
  ["POST", /^\/auth\/signout$/, (req, res) => json(res, { ok: true })],
  ["POST", /^\/auth\/account\/delete$/, (req, res) => json(res, { ok: true })],
  ["POST", /^\/auth\/signin\/email\/request$/, (req, res) => json(res, { ok: true })],
  ["POST", /^\/auth\/signin\/email\/verify$/, (req, res) => json(res, tokens())],

  // profile sync
  ["POST", /^\/profile\/sync\/pull$/, (req, res) =>
    json(res, { changes: state.changes, cursor: state.cursor, has_more: false })],
  [
    "POST",
    /^\/profile\/sync\/push$/,
    async (req, res) => {
      const body = await readBody(req)
      const applied = (body?.changes ?? []).map((c) => ({ collection: c.collection, doc_id: c.doc_id }))
      json(res, { applied, conflicts: [] })
    },
  ],
  ["POST", /^\/profile\/sync\/cursor$/, (req, res) => {
    res.writeHead(204).end()
  }],

  // discovery / orchestrator / share
  ["POST", /^\/discovery\/search$/, (req, res) => json(res, { results: [] })],
  ["GET", /^\/discovery\/search$/, (req, res) => json(res, { results: [] })],
  ["POST", /^\/orchestrator\/ingest$/, (req, res) => json(res, { jobId: "mock-job", state: "queued" })],
  ["GET", /^\/orchestrator\/ingest\/[^/]+$/, (req, res) => json(res, { jobId: "mock-job", state: "done" })],
  ["POST", /^\/share\//, (req, res) => json(res, { url: `http://localhost:${PORT}/public/media/mock.mp3` })],

  // chat: a well-formed, immediately-finished SSE stream
  [
    "POST",
    /^\/chat/,
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(`event: message\ndata: ${JSON.stringify({ type: "text", text: "mock" })}\n\n`)
      res.write(`event: done\ndata: {}\n\n`)
      res.end()
    },
  ],

  // content CDN: catalog config + any media returns the silent fixture
  ["GET", /^\/public\/config\.json$/, (req, res) =>
    json(res, { db: { version: "20260809133448", scheme: "20260621" }, servers: [] })],
  [
    "GET",
    /\.(mp3|m4a|ogg|wav)$/,
    (req, res) => {
      const file = fileURLToPath(new URL(AUDIO_FIXTURES[state.audio], FIXTURES))
      if (!existsSync(file)) return json(res, { error: "no fixture" }, 500)
      const buf = readFileSync(file)
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length })
      res.end(buf)
    },
  ],
  [
    "GET",
    /\.(jpg|jpeg|png|webp)$/,
    (req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": PIXEL.length })
      res.end(PIXEL)
    },
  ],
  ["GET", /\.(json)$/, (req, res) => json(res, {})],
]

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  state.requests.push({ method: req.method, path: url.pathname, at: Date.now() })

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    }).end()
    return
  }

  for (const [method, pattern, handler] of routes) {
    if (req.method === method && pattern.test(url.pathname)) {
      await handler(req, res)
      return
    }
  }

  state.unknown.push({ method: req.method, path: url.pathname })
  console.log(`[mock] unhandled ${req.method} ${url.pathname}`)
  json(res, { error: "not mocked", path: url.pathname }, 404)
}).listen(PORT, () => console.log(`[mock] listening on http://localhost:${PORT}`))
