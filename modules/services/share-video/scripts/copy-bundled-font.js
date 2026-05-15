// Copy NotoSans Bold (weight 700) per-script woff2 subsets from
// @fontsource/noto-sans into assets/fonts/ so the font ships inside the
// deployed Lambda artifact. Runs from `npm install` via the
// `postinstall` hook.
//
// We need both Latin and Cyrillic subsets — fontsource ships per-script
// files. Registered together under the same family name in
// fontManager.ts, @napi-rs/canvas falls through to whichever subset has
// the glyph.
//
// IMPORTANT: use the non-variable `@fontsource/noto-sans` package, NOT
// `@fontsource-variable/noto-sans`. The variable woff2 registers as
// weight=400 only — when canvas asks for "bold" (weight=700) it can't
// match and falls back to its built-in font (no Cyrillic). Per-weight
// files register with their actual OS/2 weight so `ctx.font = "bold ..."`
// resolves correctly.

const fs = require('fs');
const path = require('path');

const SUBSETS = ['latin', 'cyrillic'];
const WEIGHT = '700';
const srcDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@fontsource',
  'noto-sans',
  'files',
);
const dstDir = path.join(__dirname, '..', 'assets', 'fonts');

fs.mkdirSync(dstDir, { recursive: true });

for (const subset of SUBSETS) {
  const file = `noto-sans-${subset}-${WEIGHT}-normal.woff2`;
  const src = path.join(srcDir, file);
  const dst = path.join(dstDir, `NotoSans-${subset}-bold.woff2`);

  if (!fs.existsSync(src)) {
    console.warn(`[share-video] missing ${src} — drop it manually before deploy`);
    continue;
  }
  fs.copyFileSync(src, dst);
  console.log(`[share-video] copied ${file} -> ${path.relative(process.cwd(), dst)}`);
}

// Clean up any stale variable-font subsets from a previous install.
for (const stale of ['NotoSans-latin.woff2', 'NotoSans-cyrillic.woff2']) {
  const p = path.join(dstDir, stale);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`[share-video] removed stale ${stale}`);
  }
}
