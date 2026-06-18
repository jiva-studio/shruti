#!/usr/bin/env node
// Sync the JSON registry (the source of truth) INTO Qase. One-way: cases.json /
// suites.json → Qase case & suite definitions. The test code reads the SAME JSON,
// so steps live in exactly one place.
//
// Usage:
//   node qase/sync.mjs                 # all cases + all suites
//   node qase/sync.mjs 85 86 91        # only these case ids
//   node qase/sync.mjs --suites        # only suites
//   node qase/sync.mjs --cases         # all cases, no suites
//   node qase/sync.mjs --dry           # print what would change, send nothing
//
// Token: QASE_TESTOPS_API_TOKEN from the env or tests/e2e/mobile/.env.local.

import { readFileSync, existsSync } from "fs"

const PROJECT = process.env.QASE_TESTOPS_PROJECT || "SHRUTI"
const API = "https://api.qase.io/v1"

function loadToken() {
  if (process.env.QASE_TESTOPS_API_TOKEN) return process.env.QASE_TESTOPS_API_TOKEN
  const envFile = new URL("../.env.local", import.meta.url)
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*QASE_TESTOPS_API_TOKEN\s*=\s*(.*?)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, "")
    }
  }
  throw new Error("No QASE_TESTOPS_API_TOKEN in env or .env.local")
}

const TOKEN = loadToken()
const args = process.argv.slice(2)
const DRY = args.includes("--dry")
const ids = args.filter((a) => /^\d+$/.test(a)).map(Number)
const only = args.find((a) => a === "--suites" || a === "--cases")

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"))
const suites = JSON.parse(readFileSync(new URL("./suites.json", import.meta.url), "utf8"))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function patch(path, body, label) {
  if (DRY) {
    console.log(`  [dry] ${label}`)
    return true
  }
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { Token: TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error(`  ✘ ${label} — ${res.status} ${(await res.text()).slice(0, 200)}`)
    return false
  }
  console.log(`  ✓ ${label}`)
  return true
}

async function syncCase(id) {
  const c = cases[id]
  if (!c) return console.error(`  ! case ${id} not in registry`), false
  return patch(
    `/case/${PROJECT}/${id}`,
    {
      title: c.title,
      description: c.description,
      preconditions: c.preconditions,
      steps_type: "classic",
      steps: (c.steps || []).map((s) => ({ action: s.action, expected_result: s.expected })),
    },
    `case ${id}  ${c.title}`
  )
}

async function syncSuite(id) {
  const s = suites[id]
  if (!s) return false
  return patch(`/suite/${PROJECT}/${id}`, { title: s.title, description: s.description }, `suite ${id}  ${s.title}`)
}

let ok = 0
let fail = 0
const tally = (r) => (r ? ok++ : fail++)

if (ids.length) {
  console.log(`Syncing ${ids.length} case(s)…`)
  for (const id of ids) {
    tally(await syncCase(id))
    await sleep(120)
  }
} else {
  if (only !== "--suites") {
    console.log(`Syncing ${Object.keys(cases).length} cases…`)
    for (const id of Object.keys(cases)) {
      tally(await syncCase(id))
      await sleep(120)
    }
  }
  if (only !== "--cases") {
    console.log(`Syncing ${Object.keys(suites).length} suites…`)
    for (const id of Object.keys(suites)) {
      tally(await syncSuite(id))
      await sleep(120)
    }
  }
}

console.log(`\nDone. ${ok} ok, ${fail} failed.`)
process.exit(fail ? 1 : 0)
