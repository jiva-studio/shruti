/** A colour pair for a tile with no art, derived from its title so the same
 *  track is always the same colour. */
export function tintFor(title: string): [string, string] {
  let hue = 0
  for (const ch of title) hue = (hue * 31 + ch.codePointAt(0)!) % 360
  return [`hsl(${hue}, 46%, 42%)`, `hsl(${(hue + 38) % 360}, 42%, 24%)`]
}
