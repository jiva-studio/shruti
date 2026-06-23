// Derives the gradient backdrop map (file -> {top, bottom}) consumed by
// ScreenshotShowcase.astro from the committed screenshot PNGs themselves:
// the top/bottom colours are the mean colour of each shot's top and bottom
// edge band, so the page background blends into the screenshot.
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const screensDir = join(webRoot, 'public', 'screens', 'en')
const outFile = join(webRoot, 'src', 'data', 'screenshots.json')

const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

async function bandColor(srcPath, meta, fromTop) {
  const bandH = Math.max(1, Math.round(meta.height * 0.04))
  const top = fromTop ? 0 : meta.height - bandH
  const { data } = await sharp(srcPath)
    .extract({ left: 0, top, width: meta.width, height: bandH })
    .resize(1, 1, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return hex({ r: data[0], g: data[1], b: data[2] })
}

const map = {}
for (const f of readdirSync(screensDir).filter((f) => f.endsWith('.png'))) {
  const key = f.replace(/\.png$/, '')
  const srcPath = join(screensDir, f)
  const meta = await sharp(srcPath).metadata()
  map[key] = { top: await bandColor(srcPath, meta, true), bottom: await bandColor(srcPath, meta, false) }
}

if (!existsSync(dirname(outFile))) mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(map, null, 2) + '\n')
console.log(`Wrote ${Object.keys(map).length} entries to ${outFile}`)
console.log(map)
