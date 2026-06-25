import { writeFileSync } from 'node:fs'
import sharp from 'sharp'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('no OPENROUTER_API_KEY')
  process.exit(1)
}

const prompt =
  'A warm, inviting background image for a website pricing section, wide landscape orientation. A soft honey-amber and golden-cream gradient with a clearly visible (but gentle) large ornate glowing golden mandala / sacred-geometry medallion in the upper-right area, radiating warm light and soft incense-smoke haze with warm bokeh. Keep it medium-light and warm overall — readable behind dark text — with NO dark or black areas and no harsh shadows, but the ornament and glow should be clearly present, not washed out. Premium, spiritual Indian temple warmth, textured like aged paper. Absolutely no text, no letters, no people, no logos.'

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash-image',
    modalities: ['image', 'text'],
    messages: [{ role: 'user', content: prompt }],
  }),
})

if (!res.ok) {
  console.error('http', res.status, (await res.text()).slice(0, 400))
  process.exit(1)
}

const j = await res.json()
const img = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url
if (!img || !img.startsWith('data:')) {
  console.error('no image in response:', JSON.stringify(j).slice(0, 500))
  process.exit(1)
}
const raw = Buffer.from(img.split(',')[1], 'base64')
// Resize + JPEG so it's ~150-250 KB instead of a 1 MB PNG.
const out = await sharp(raw).resize(1600).jpeg({ quality: 78, mozjpeg: true }).toBuffer()
writeFileSync('public/pro-bg.jpg', out)
console.log('saved public/pro-bg.jpg', Math.round(out.length / 1024), 'KB')
