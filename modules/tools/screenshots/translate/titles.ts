/**
 * Fill in screenshot headlines (frame/titles.json) for every capture locale
 * that doesn't have them yet, by translating the English headlines via the LLM.
 *
 * Source of truth for which locales exist = the store registry (config.ts /
 * store-locales.json). Canonical locales (en, ru) are hand-authored and never
 * touched. For each missing locale this asks the model to translate all eight
 * headlines at once, keeping them short and natural (these are marketing
 * banners over a phone frame, not literal sentences).
 *
 * Run:  OPENROUTER_API_KEY=… npm run translate-titles
 * Idempotent — locales that already have all headlines are skipped, so it only
 * does work for newly-added languages.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CAPTURE_LOCALES, STORE_LOCALES } from "../config.js"
import { complete, parseJsonReply } from "./llm.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TITLES_PATH = path.resolve(__dirname, "../frame/titles.json")

type Titles = Record<string, Record<string, string>>

function buildPrompt(locale: string, english: Record<string, string>): string {
  const lines = Object.entries(english)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n")
  return `You localize App Store / Google Play screenshot headlines for "Shruti",
a mobile app for listening to a curated library of recorded spiritual lectures
(audio playback, transcripts, search, notes, an in-app "Ask Sadhu" assistant,
and a library of sacred texts).

Translate each English headline below into locale "${locale}". These are short
marketing banners shown above a phone screenshot — keep them punchy and natural
in the target language, not a literal word-for-word translation. Match the tone
of the English. Do not add punctuation that wasn't there. Keep "Sadhu" as-is.
Each headline should comfortably fit on two short lines.

English headlines (key: text):
${lines}

Respond with ONLY a JSON object mapping each key to the translated string. No
prose, no markdown fences.`
}

async function main(): Promise<void> {
  const titles = JSON.parse(fs.readFileSync(TITLES_PATH, "utf-8")) as Titles
  const scenarioKeys = Object.keys(titles)

  // Locales that need filling: captured, not canonical, missing ≥1 headline.
  const targets = CAPTURE_LOCALES.filter((loc) => {
    if (STORE_LOCALES[loc]?.canonical) return false
    return scenarioKeys.some((s) => !titles[s]?.[loc])
  })

  if (targets.length === 0) {
    console.log("All capture locales already have headlines — nothing to do.")
    return
  }

  for (const loc of targets) {
    const english = Object.fromEntries(scenarioKeys.map((s) => [s, titles[s]!.en!]))
    console.log(`Translating ${scenarioKeys.length} headlines → ${loc} …`)
    const translated = parseJsonReply<Record<string, string>>(await complete(buildPrompt(loc, english)))
    for (const s of scenarioKeys) {
      const t = translated[s]?.trim()
      if (!t) throw new Error(`Model omitted headline "${s}" for ${loc}`)
      titles[s]![loc] = t
    }
  }

  fs.writeFileSync(TITLES_PATH, JSON.stringify(titles, null, 2) + "\n")
  console.log(`Wrote ${targets.length} locale(s) → ${path.relative(process.cwd(), TITLES_PATH)}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
