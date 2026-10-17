// Nick colours. A nick hashes to a hue. Saturation and lightness come from CSS
// variables (--nick-s, --nick-l), so one hue stays readable in both themes.

/** FNV-1a over the lowercase nick, mapped to 0..359. */
export function nickHue(nick: string): number {
  let h = 0x811c9dc5
  for (const ch of nick.toLowerCase()) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 360
}

/** A CSS colour for a nick. `overrides` maps lowercase nicks to any CSS colour. */
export function nickColor(nick: string, overrides: Record<string, string> = {}): string {
  const custom = overrides[nick.toLowerCase()]
  if (custom && /^#[0-9a-f]{3,8}$/i.test(custom)) return custom
  return `hsl(${nickHue(nick)} var(--nick-s) var(--nick-l))`
}
