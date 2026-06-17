/**
 * Fill in per-locale App Store / Google Play listing copy by translating the
 * canonical English listing. The English listing under
 * fastlane/metadata/{android,ios}/en-US is the source of truth; this writes the
 * translated files for every registry locale that doesn't have them yet.
 *
 * Rules:
 *  - Canonical locales (en, ru) are never written.
 *  - The app NAME / title is a brand and is copied verbatim, never translated.
 *  - Google Play files go to metadata/android/<play>/ (skipped if play is null).
 *  - App Store files go to metadata/ios/<appStore>/ (skipped if appStore is null —
 *    e.g. Serbian, which App Store Connect does not support).
 *  - Idempotent: a locale whose files already exist is skipped (pass --force to
 *    re-translate).
 *
 * Run:  OPENROUTER_API_KEY=… npm run translate-store-copy [-- --force]
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { STORE_LOCALES } from "../config.js"
import { complete, parseJsonReply } from "./llm.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const METADATA = path.resolve(__dirname, "../../../apps/mobile/fastlane/metadata")
const FORCE = process.argv.includes("--force")

interface Field {
  /** File name (without dir), e.g. "short_description.txt". */
  file: string
  /** Human label fed to the model so it respects length/intent. */
  label: string
  /** Hard character cap the store enforces. */
  max: number
}

/** Per-platform layout: where the brand line + translatable fields live. */
const PLATFORMS = {
  android: {
    brand: "title.txt",
    fields: [
      { file: "short_description.txt", label: "short description", max: 80 },
      { file: "full_description.txt", label: "full description", max: 4000 },
    ] as Field[],
  },
  ios: {
    brand: "name.txt",
    fields: [
      { file: "subtitle.txt", label: "subtitle", max: 30 },
      { file: "description.txt", label: "full description", max: 4000 },
      { file: "keywords.txt", label: "comma-separated keywords (no spaces after commas)", max: 100 },
    ] as Field[],
  },
} as const
type Platform = keyof typeof PLATFORMS

interface Job {
  platform: Platform
  locale: string
  srcDir: string
  dstDir: string
}

function read(file: string): string {
  return fs.readFileSync(file, "utf-8").replace(/\n+$/, "")
}

function buildPrompt(locale: string, fields: { label: string; max: number; text: string }[]): string {
  const blocks = fields.map((f) => `### ${f.label} (max ${f.max} characters)\n${f.text}`).join("\n\n")
  return `You localize App Store / Google Play listing copy for "Shruti", a
mobile app for listening to a curated library of recorded spiritual lectures
(audio playback, transcripts, search, notes, offline downloads, an in-app
"Ask Sadhu" assistant, and a library of sacred texts).

Translate the English fields below into locale "${locale}". Rules:
- Idiomatic, natural marketing voice in the target language — NOT a literal or
  transliterated rendering.
- Stay within each field's character limit.
- Keep the brand "Shruti" and the word "Sadhu" as-is. Use the locale's
  standard names for the scriptures (Bhagavad-gita, Srimad-Bhagavatam) if one
  exists, otherwise keep them.
- Do not invent features that are not present in the English text.
- Preserve the structure of the full description (the same blank lines, the
  "WHAT YOU CAN DO"-style header translated, and the "• " bullet lines).
- For keywords: a comma-separated list, no spaces after commas, under the limit.

${blocks}

Respond with ONLY a JSON object mapping each field label to its translation. No
prose, no markdown fences.`
}

/** Translate one platform-locale: copy the brand verbatim, LLM-translate the rest. */
async function runJob(job: Job): Promise<void> {
  const { brand, fields } = PLATFORMS[job.platform]
  fs.mkdirSync(job.dstDir, { recursive: true })
  fs.writeFileSync(path.join(job.dstDir, brand), read(path.join(job.srcDir, brand)) + "\n")

  const inputs = fields.map((f) => ({ ...f, text: read(path.join(job.srcDir, f.file)) }))
  const out = parseJsonReply<Record<string, string>>(await complete(buildPrompt(job.locale, inputs)))
  for (const f of fields) {
    const v = out[f.label]?.trim()
    if (!v) throw new Error(`Model omitted "${f.label}" for ${job.platform}/${job.locale}`)
    if (v.length > f.max) throw new Error(`"${f.label}" for ${job.platform}/${job.locale} exceeds ${f.max} chars`)
    fs.writeFileSync(path.join(job.dstDir, f.file), v + "\n")
  }
  console.log(`  ${job.platform}/${path.basename(job.dstDir)}: wrote ${fields.length} field(s)`)
}

/** A platform-locale needs work if any of its files is missing (or --force). */
function needsWork(platform: Platform, dstDir: string): boolean {
  if (FORCE) return true
  return PLATFORMS[platform].fields.some((f) => !fs.existsSync(path.join(dstDir, f.file)))
}

async function main(): Promise<void> {
  const jobs: Job[] = []
  for (const [locale, entry] of Object.entries(STORE_LOCALES)) {
    if (entry.canonical) continue
    const stores: [Platform, string | null][] = [
      ["android", entry.play],
      ["ios", entry.appStore],
    ]
    for (const [platform, code] of stores) {
      if (!code) continue
      const dstDir = path.join(METADATA, platform, code)
      if (!needsWork(platform, dstDir)) continue
      jobs.push({ platform, locale, srcDir: path.join(METADATA, platform, "en-US"), dstDir })
    }
  }

  if (jobs.length === 0) {
    console.log("All registry locales already have store copy — nothing to do.")
    return
  }
  console.log(`Translating store copy for ${jobs.length} platform-locale target(s) …`)
  await Promise.all(jobs.map(runJob))
  console.log("Done.")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
