import { writeFileSync } from 'node:fs'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('no OPENROUTER_API_KEY')
  process.exit(1)
}

const prompt =
  'A warm, richly lit wide horizontal background image for a website banner, landscape orientation. Deep amber, honey and coffee-brown tones glowing with soft golden light. On the right side, a large ornate glowing golden mandala / sacred-geometry medallion radiating warm light that spreads softly across the whole frame, with gentle incense-smoke haze and warm bokeh. The left side is a little darker and calmer to hold white text, but still warm and textured — never pure black. The ornament and glow sit in the vertical middle so they survive a wide crop. Cinematic, premium, inviting, spiritual Indian temple atmosphere. Absolutely no text, no letters, no people, no logos.'

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  },
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
const b64 = img.split(',')[1]
writeFileSync('public/cta-bg.png', Buffer.from(b64, 'base64'))
console.log('saved public/cta-bg.png', Math.round(Buffer.from(b64, 'base64').length / 1024), 'KB')
