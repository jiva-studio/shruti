import { test } from "@playwright/test"
import fs from "fs"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { scenarios } from "../scenarios.js"
import titlesRaw from "../frame/titles.json" with { type: "json" }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(__dirname, "..")
const TEMPLATE_URL = pathToFileURL(path.resolve(TOOL_ROOT, "frame/template.html")).toString()

const titles = titlesRaw as Record<string, Record<string, string>>

type Device = "phone" | "iphone67" | "ipad13" | "surfaceduo"

function projectInfo(name: string): { device: Device; code: "en" | "ru" } {
  const [device, code] = name.split("-") as [Device, "en" | "ru"]
  return { device, code }
}

for (const scenario of scenarios) {
  test(`frame ${scenario.name}`, async ({ page }, testInfo) => {
    const { device, code } = projectInfo(testInfo.project.name)
    const rawPath = path.resolve(TOOL_ROOT, `out/raw/${device}-${code}/${scenario.name}.png`)
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Missing raw ${rawPath}. Run \`npm run capture\` first.`)
    }
    const outPath = path.resolve(TOOL_ROOT, `out/framed/${device}-${code}/${scenario.name}.png`)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })

    const title = titles[scenario.name]?.[code]
    if (!title) throw new Error(`No title for ${scenario.name}/${code}`)

    const shotUrl = pathToFileURL(rawPath).toString()
    const url = `${TEMPLATE_URL}?device=${device}&title=${encodeURIComponent(title)}&shot=${encodeURIComponent(shotUrl)}`

    await page.goto(url)
    await page.waitForFunction(() => {
      const img = document.getElementById("shot") as HTMLImageElement | null
      return !!img && img.complete && img.naturalWidth > 0
    })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: outPath, fullPage: false, omitBackground: false })
    console.log(`  → ${path.relative(path.resolve(TOOL_ROOT, "../../.."), outPath)}`)
  })
}
