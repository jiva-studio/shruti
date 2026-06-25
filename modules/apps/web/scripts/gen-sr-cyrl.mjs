#!/usr/bin/env node
// Generate the sr-cyrl UI strings by transliterating the hand-authored
// sr-latn bundle with the project's canonical, deterministic Serbian
// Latin→Cyrillic map (modules/tools/sr-transliterate) — the same one the
// mobile app uses for its sr-Cyrl/ bundle. sr-cyrl.json is committed but
// generated: never hand-edit it, re-run this after touching sr-latn.json.
//
//   node modules/apps/web/scripts/gen-sr-cyrl.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { srLatinToCyrillic } from '../../../tools/sr-transliterate/srLatinToCyrillic.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STRINGS = join(__dirname, '../src/i18n/strings')

// Latin brand / product tokens that must stay in Latin (the transliterator
// would otherwise turn iPhone → иПхоне). Longest first.
const PROTECTED = ['App Store', 'Google Play', 'Apple', 'Google', 'iPhone', 'iPad', 'Android', 'iOS', 'PRO', 'USDT', '{date}', '{n}']
const SPLIT = new RegExp(`(${PROTECTED.join('|')})`, 'g')

function translit(value) {
  return value
    .split(SPLIT)
    .map((part) => (PROTECTED.includes(part) ? part : srLatinToCyrillic(part)))
    .join('')
}

const src = JSON.parse(readFileSync(join(STRINGS, 'sr-latn.json'), 'utf8'))
const out = {}
for (const [k, v] of Object.entries(src)) out[k] = translit(v)
writeFileSync(join(STRINGS, 'sr-cyrl.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`sr-cyrl.json ← sr-latn.json (${Object.keys(out).length} keys)`)
