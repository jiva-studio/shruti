import * as fs from 'fs';
import * as path from 'path';
import { GlobalFonts } from '@napi-rs/canvas';

/**
 * Family-list string fed to canvas as `ctx.font = "bold 80px ${FONT_FAMILY}"`.
 *
 * Why a list, not a single name: `GlobalFonts.registerFromPath(path, alias)`
 * does NOT merge multiple files registered under the same alias — the
 * first-registered file wins and subsequent ones are silently ignored. So
 * registering Latin and Cyrillic woff2 subsets both as "NotoSans" leaves
 * us with only one script's glyphs (the rest render as tofu).
 *
 * Solution: register each subset under its own alias, then list them in
 * the font string. Canvas walks the list and picks the first font that
 * has the glyph it needs.
 */
export const FONT_FAMILY = 'NotoSansLatin, NotoSansCyrillic, sans-serif';

let registered = false;

export function registerFonts(assetsDir?: string): void {
  if (registered) return;

  const baseDir = assetsDir ?? findAssetsFonts(__dirname);

  const subsets: Array<{ file: string; alias: string }> = [
    { file: 'NotoSans-latin-bold.woff2', alias: 'NotoSansLatin' },
    { file: 'NotoSans-cyrillic-bold.woff2', alias: 'NotoSansCyrillic' },
  ];

  let bundledHits = 0;
  for (const s of subsets) {
    const full = path.join(baseDir, s.file);
    if (fs.existsSync(full)) {
      GlobalFonts.registerFromPath(full, s.alias);
      bundledHits += 1;
    }
  }

  if (bundledHits > 0) {
    registered = true;
    return;
  }

  // Local-dev fallback: try a few system fonts under "NotoSansLatin" so
  // the rest of the pipeline doesn't have to care which one won. (System
  // sans-serif usually has both Latin and Cyrillic, so a single
  // registration is fine here.)
  const fallbacks = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:\\Windows\\Fonts\\arialbd.ttf',
  ];
  for (const f of fallbacks) {
    if (fs.existsSync(f)) {
      GlobalFonts.registerFromPath(f, 'NotoSansLatin');
      GlobalFonts.registerFromPath(f, 'NotoSansCyrillic');
      registered = true;
      return;
    }
  }

  console.warn(
    `[share-video] no font found at ${baseDir} or system paths; ` +
      'canvas will use its built-in fallback (limited Cyrillic coverage)',
  );
}

function findAssetsFonts(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'assets', 'fonts');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(startDir, '..', '..', '..', 'assets', 'fonts');
}
